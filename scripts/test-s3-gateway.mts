// Integration test for an explicitly selected staging Worker.
// pnpm exec tsx scripts/test-s3-gateway.mts
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { signS3Headers } from "../src/backend/drivers/s3/sigv4"

const endpoint = process.env.OPENLIST_TEST_S3_ENDPOINT?.replace(/\/+$/, "")
const accessKeyId = process.env.OPENLIST_TEST_S3_KEY
const secretAccessKey = process.env.OPENLIST_TEST_S3_SECRET
const bucket = process.env.OPENLIST_TEST_S3_BUCKET || "drive"
assert.ok(endpoint && accessKeyId && secretAccessKey, "Set OPENLIST_TEST_S3_ENDPOINT, OPENLIST_TEST_S3_KEY and OPENLIST_TEST_S3_SECRET")
assert.ok(endpoint.startsWith("https://") && endpoint.endsWith("/s3"), "Expected an HTTPS Worker /s3 endpoint")
const credentials = { accessKeyId, secretAccessKey, region: "us-east-1" }
const unique = "openlist-s3-smoke-" + randomUUID()
const mib = 1024 * 1024
const chunk = Buffer.alloc(50 * mib, 91)
const tail = Buffer.alloc(mib + 1, 23)
const partCount = 6
const baseKey = endpoint + "/" + bucket + "/" + unique

async function request(method: string, url: string, body?: string | Uint8Array<ArrayBuffer>, headers?: Record<string, string>) {
  const signed = await signS3Headers({ ...credentials, method, url, body, headers })
  return fetch(url, { method, headers: signed.headers, body, redirect: "manual" })
}

async function expect(response: Response, status: number) {
  assert.equal(response.status, status, (await response.clone().text()).slice(0, 500))
  return response
}

async function begin(key: string) {
  const result = await (await expect(await request("POST", key + "?uploads"), 200)).text()
  const id = /<UploadId>([^<]+)<\/UploadId>/.exec(result)?.[1]
  assert.ok(id)
  return id
}

async function uploadPart(key: string, id: string, number: number, bytes: Uint8Array<ArrayBuffer>) {
  const result = await expect(await request("PUT", key + "?uploadId=" + id + "&partNumber=" + number, bytes, {
    "content-md5": createHash("md5").update(bytes).digest("base64"),
  }), 200)
  const etag = result.headers.get("etag")
  assert.ok(etag)
  return etag
}

const abortKey = baseKey + "-abort.bin"
const cancelled = await begin(abortKey)
try {
  await uploadPart(abortKey, cancelled, 1, tail)
  const bucketResponse = await expect(await request("GET", endpoint + "/" + bucket + "?uploads"), 200)
  assert.match(await bucketResponse.text(), new RegExp(cancelled))
} finally {
  await expect(await request("DELETE", abortKey + "?uploadId=" + cancelled), 204)
}
await expect(await request("GET", abortKey + "?uploadId=" + cancelled), 404)

const key = baseKey + ".bin"
const id = await begin(key)
const query = "?uploadId=" + id
console.log("Staging smoke upload", key, id)
let completed = false
try {
  const etags: string[] = []
  for (const group of [[1, 2, 3, 4], [5, 6]]) {
    etags.push(...await Promise.all(group.map(number => uploadPart(key, id, number, chunk))))
  }
  assert.equal(await uploadPart(key, id, 2, chunk), etags[1])
  const list = await expect(await request("GET", key + query), 200)
  const parts = await list.text()
  assert.match(parts, /<PartNumber>6<\/PartNumber>/)
  assert.match(parts, /<Size>52428800<\/Size>/)
  const manifest = "<CompleteMultipartUpload>" + etags.map((etag, i) =>
    "<Part><PartNumber>" + (i + 1) + "</PartNumber><ETag>" + etag + "</ETag></Part>").join("") + "</CompleteMultipartUpload>"
  const first = await expect(await request("POST", key + query, manifest), 200)
  completed = true
  const second = await expect(await request("POST", key + query, manifest), 200)
  assert.equal(await first.text(), await second.text())
  const size = chunk.byteLength * partCount
  assert.equal((await expect(await request("HEAD", key), 200)).headers.get("content-length"), String(size))

  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    const response = await expect(await request("GET", key + query + "&openlist-status"), 200)
    const status = await response.json() as { bytes: number; state: string; size: number; driveId?: string; error?: string }
    assert.notEqual(status.state, "failed", status.error ?? "Drive transfer failed")
    if (status.state === "done") {
      assert.ok(status.driveId)
      assert.equal(status.size, size)
      assert.equal(status.bytes, 0)
      const downloaded = await expect(await request("GET", key), 302)
      assert.ok(downloaded.headers.get("location"))
      console.log("Verified Drive file and released R2 reservation", status.driveId, size)
      break
    }
    await delay(5000)
  }
  const final = await (await expect(await request("GET", key + query + "&openlist-status"), 200)).json() as { state: string }
  assert.equal(final.state, "done", "Transfer has not finished. Inspect the upload status before retrying.")
} finally {
  if (!completed) {
    const cleanup = await request("DELETE", key + query)
    assert.ok([204, 404].includes(cleanup.status), "Could not abort the test multipart upload")
  }
}

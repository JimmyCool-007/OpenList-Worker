import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { unstable_dev } from "wrangler"
import { MiB, S3_CHUNK_SIZE } from "../src/backend/internal/s3/protocol"
import type { Part, UploadStatus, StagedObject } from "../src/backend/internal/s3/protocol"

const scratch = await mkdtemp(join(tmpdir(), "openlist-s3-r2-"))
const config = join(scratch, "wrangler.json")
const entry = fileURLToPath(new URL("./fixtures/s3-r2-worker.ts", import.meta.url))
try {
  await writeFile(config, JSON.stringify({
    name: "openlist-r2-binding-test",
    compatibility_date: "2026-08-04",
    compatibility_flags: ["nodejs_compat"],
    vars: { S3_UPLOAD_MODE: "enabled" },
    r2_buckets: [{ binding: "R2", bucket_name: "isolated-s3-test" }],
    durable_objects: { bindings: [{ name: "S3_UPLOADS", class_name: "TestUploads" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TestUploads"] }],
  }))
  const worker = await unstable_dev(entry, { config, local: true, persist: false })
  try {
    async function call<T>(action: string, params?: object, body?: Uint8Array<ArrayBuffer>, status = 200) {
      const res = await worker.fetch("http://localhost/" + action, {
        method: "POST",
        headers: body ? { "x-upload-parameters": encodeURIComponent(JSON.stringify(params)) } : {},
        body: body ?? (params && JSON.stringify(params)),
      })
      const json = await res.text()
      assert.equal(res.status, status, json)
      return JSON.parse(json) as T
    }
    const file = "binding-test.bin"
    const path = "/drive/" + file
    const payload = {
      owner: 7, path, target: { path, rootId: "root", parentId: "root", name: file, storageId: 1 },
      metadata: { contentType: "application/octet-stream" },
    }
    const { id } = await call<UploadStatus>("create", payload)
    const scope = { owner: 7, path, id }
    // Keep this real Miniflare binding test at the previously stable 50 MiB
    // transport size: unstable_dev() can lose its local transport on 75 MiB
    // request bodies. The 75 MiB coordinator limit and streamed transfer are
    // covered separately by src/backend/internal/s3/uploads.test.ts.
    const bindingPartSize = 50 * MiB
    assert.ok(S3_CHUNK_SIZE >= bindingPartSize)
    const chunks = [new Uint8Array(bindingPartSize), new Uint8Array(13)]
    const manifest = []
    for (const [index, bytes] of chunks.entries()) {
      const md5 = createHash("md5").update(bytes).digest("hex")
      const { partNumber, etag } =
        await call<Part>("part", { ...scope, number: index + 1, size: bytes.length, checksums: { md5 } }, bytes)
      manifest.push({ partNumber, etag })
    }
    const complete = await call<UploadStatus>("complete", { ...scope, manifest })
    assert.equal(complete.state, "staged")
    assert.equal(complete.size, bindingPartSize + 13)
    const object = await call<StagedObject>("fixture-object?id=" + id)
    assert.equal(object.customMetadata?.openlistUpload, id)
    assert.equal(object.etag, complete.etag)
    await call("discard", { id }, undefined, 409)
    await call("fixture-fail?id=" + id)
    const replacement = await call<UploadStatus>("create", payload)
    assert.notEqual(replacement.id, id)
    await call("retry", scope, undefined, 409)
    const cleanup = await call<UploadStatus>("discard", { id })
    assert.equal(cleanup.state, "aborted")
    assert.equal(cleanup.bytes, 0)
    assert.equal(await call("fixture-object?id=" + id), null)
    assert.equal((await call<{ reserved: number }>("quota", {})).reserved, 0)
    await call("abort", { ...scope, id: replacement.id })
    console.log("R2 binding multipart, legacy failure and scoped discard passed")
  } finally {
    await worker.stop()
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

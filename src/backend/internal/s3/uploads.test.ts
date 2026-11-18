import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { S3Uploads } from "../../durable-objects/S3Uploads"
import { signS3Headers } from "../../drivers/s3/sigv4"
import type { GoogleDriveClient } from "../../drivers/google_drive/util"
import { saveDb } from "../model/db"
import { s3Router } from "../../server/s3"
import { UploadLedger } from "./ledger"
import type { LedgerStorage, UploadJob } from "./ledger"
import { MAX_BUCKET_BYTES, MAX_FILE_SIZE, MiB, S3_CHUNK_SIZE, STAGING_PREFIX } from "./protocol"
import type { Part, StagedObject, UploadEnv, UploadStatus } from "./protocol"
import { verifyS3Signature } from "./sigv4"

if (!Reflect.has(globalThis, "FixedLengthStream")) {
  Reflect.set(globalThis, "FixedLengthStream", class extends TransformStream {
    constructor(_length: number) { super() }
  })
}

function memoryStorage(): LedgerStorage {
  const sqlite = new DatabaseSync(":memory:")
  let alarm: number | null = null
  return {
    sql: {
      exec(query, ...parameters) {
        const rows = sqlite.prepare(query).all(...parameters)
        return { toArray: () => rows }
      },
    },
    transactionSync<T>(callback: () => T): T {
      sqlite.exec("BEGIN")
      try {
        const result = callback()
        sqlite.exec("COMMIT")
        return result
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
    async sync() {},
    async getAlarm() { return alarm },
    async setAlarm(time) { alarm = time },
  }
}

function newJob(path: string, bytes = 0): UploadJob {
  return {
    id: crypto.randomUUID(), owner: 7, path, state: "open", bytes,
    target: { path, name: path.split("/").at(-1)!, rootId: "real-root", parentId: "real-root", storageId: 12 },
    metadata: { contentType: "application/octet-stream" },
    created: Date.now(), updated: Date.now(), offset: 0, attempts: 0, next: 0, sent: 0,
  }
}

test("50 MiB reservations admit 300 MiB, 2 GiB and exactly 5 GB, but reject a byte over 5 GB", () => {
  const ledger = new UploadLedger(memoryStorage())
  for (const target of [300 * MiB, 1024 * MiB, 2 * 1024 * MiB, MAX_FILE_SIZE]) {
    const job = newJob("/drive/" + target)
    ledger.insert(job)
    let remaining = target
    let number = 1
    while (remaining) {
      const size = Math.min(S3_CHUNK_SIZE, remaining)
      ledger.reservePart(job.id, number, size, 0)
      ledger.commitPart(job.id, { partNumber: number++, size, etag: "etag", date: 1000 })
      remaining -= size
    }
    assert.equal(ledger.reserved(), target)
    if (target === MAX_FILE_SIZE) {
      assert.throws(() => ledger.reservePart(job.id, number, 1, 0), { code: "EntityTooLarge" })
    }
    ledger.closeParts({ ...job, state: "aborted", bytes: 0 })
  }
})

test("two concurrent uploads share the 9 GB capacity with pre-existing objects and overwrite reservations", () => {
  const ledger = new UploadLedger(memoryStorage())
  const existing = MAX_BUCKET_BYTES - 2 * S3_CHUNK_SIZE
  const a = newJob("/drive/a")
  const b = newJob("/drive/b")
  ledger.insert(a)
  ledger.insert(b)
  ledger.reservePart(a.id, 1, S3_CHUNK_SIZE, existing)
  ledger.commitPart(a.id, { partNumber: 1, size: S3_CHUNK_SIZE, etag: "one", date: 1 })
  ledger.reservePart(a.id, 1, S3_CHUNK_SIZE, existing)
  assert.throws(() => ledger.reservePart(b.id, 1, 1, existing), { code: "ServiceUnavailable" })
  ledger.commitPart(a.id, { partNumber: 1, size: S3_CHUNK_SIZE, etag: "replacement", date: 2 })
  ledger.reservePart(b.id, 1, S3_CHUNK_SIZE, existing)
  assert.throws(() => ledger.reservePart(b.id, 2, 1, existing), { code: "ServiceUnavailable" })
  assert.equal(ledger.reserved() + existing, MAX_BUCKET_BYTES)
})

test("SigV4 accepts the full /s3 path and rejects changed query and digest headers", async () => {
  const base = "https://worker.example/s3/drive/%E6%B5%8B%20%E8%AF%95.bin?partNumber=1&uploadId=test"
  const headers = { "content-md5": "kAFQmDzST7DWlj99KOF/cg==" }
  const signed = await signS3Headers({
    method: "PUT", url: base, body: "abc", region: "us-east-1",
    accessKeyId: "openlist-test", secretAccessKey: "only-for-test", headers,
  })
  const env = { S3_ACCESS_KEY_ID: "openlist-test", S3_SECRET_ACCESS_KEY: "only-for-test", S3_USER_ID: "7" }
  assert.equal(await verifyS3Signature(new Request(base, { method: "PUT", headers: signed.headers }), env), 7)
  await assert.rejects(() => verifyS3Signature(
    new Request(base.replace("partNumber=1", "partNumber=2"), { method: "PUT", headers: signed.headers }), env,
  ), { code: "SignatureDoesNotMatch" })
  await assert.rejects(() => verifyS3Signature(new Request(base, {
    method: "PUT", headers: { ...signed.headers, "content-md5": "1B2M2Y8AsgTpgAmY7PhCfg==" },
  }), env), { code: "SignatureDoesNotMatch" })
})

test("SigV4 uses the original Accept-Encoding when Cloudflare rewrites it", async () => {
  const url = "https://worker.example/s3/drive?delimiter=%2F&list-type=2&prefix="
  const env = { S3_ACCESS_KEY_ID: "openlist-test", S3_SECRET_ACCESS_KEY: "only-for-test", S3_USER_ID: "7" }
  const signed = await signS3Headers({
    method: "GET", url, region: "us-east-1", accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY, headers: { "accept-encoding": "identity" },
  })
  const request = new Request(url, { headers: { ...signed.headers, "accept-encoding": "br, gzip" } })

  assert.equal(await verifyS3Signature(new Request(url, { headers: signed.headers }), env), 7)
  await assert.rejects(() => verifyS3Signature(request, env), { code: "SignatureDoesNotMatch" })

  Object.defineProperty(request, "cf", { value: { clientAcceptEncoding: "identity" }, configurable: true })
  assert.equal(await verifyS3Signature(request, env), 7)

  Object.defineProperty(request, "cf", { value: { clientAcceptEncoding: "gzip" } })
  await assert.rejects(() => verifyS3Signature(request, env), { code: "SignatureDoesNotMatch" })
})

function fakeServices() {
  const objects = new Map<string, StagedObject>()
  const queue: string[] = []
  const writes: number[] = []
  let completeCalls = 0
  let abortCalls = 0
  let sendFails = false
  let loseComplete = false
  let wrongSize = false
  let committed = 0
  let lost = true
  let file: Record<string, unknown> | null = null
  let driveMetadata: Record<string, unknown>
  const url = "https://www.googleapis.com/upload/drive/v3/files?upload_id=test-id"
  const prefixMpu = new Map<string, { parts: Map<number, Part>; options: object }>()

  function makeObject(key: string, size: number, etag: string, options: object): StagedObject {
    return { key, size, etag, version: "v1", customMetadata: (options as { customMetadata: Record<string, string> }).customMetadata }
  }

  const digestBody = async (body: ReadableStream<Uint8Array> | Uint8Array) => {
    const h = createHash("md5")
    let size = 0
    if (body instanceof Uint8Array) {
      h.update(body)
      size = body.byteLength
    } else {
      const reader = body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        h.update(value)
      }
    }
    return { size, etag: h.digest("hex") }
  }

  const env: UploadEnv = {
    S3_UPLOAD_MODE: "enabled",
    S3_UPLOADS: { idFromName: () => "", get() { throw new Error("unused") } },
    UPLOAD_QUEUE: {
      async send(job) {
        assert.ok(objects.has(STAGING_PREFIX + job.id), "obj must exist before queue dispatch")
        if (sendFails) throw new Error("queue unavailable")
        queue.push(job.id)
      },
    },
    R2: {
      async createMultipartUpload(key, options) {
        prefixMpu.set(key, { parts: new Map(), options })
        return env.R2.resumeMultipartUpload(key, key)
      },
      resumeMultipartUpload(key) {
        return {
          uploadId: key,
          async uploadPart(partNumber, body) {
            const part = await digestBody(body)
            prefixMpu.get(key)!.parts.set(partNumber, { ...part, partNumber, date: 0 })
            return part
          },
          async abort() {
            abortCalls++
            prefixMpu.delete(key)
          },
          async complete(parts) {
            completeCalls++
            const upload = prefixMpu.get(key)!
            const chosen = parts.map(({ partNumber, etag }) => {
              const part = upload.parts.get(partNumber)!
              assert.equal(part.etag, etag)
              return part
            })
            const object = makeObject(key, chosen.reduce((sum, part) => sum + part.size, 0), "r2-multipart-etag", upload.options)
            objects.set(key, object)
            prefixMpu.delete(key)
            if (loseComplete) throw new Error("lost Complete response after R2 persisted the object")
            return { ...object, customMetadata: undefined }
          },
        }
      },
      async put(key, body, options) {
        const { size, etag } = await digestBody(body)
        const object = makeObject(key, size, etag, options)
        objects.set(key, object)
        return object
      },
      async head(key) { return objects.get(key) ?? null },
      async get(key, options) {
        const object = objects.get(key)
        if (!object) return null
        const { range: { offset, length } } = options as { range: { offset: number; length: number } }
        assert.ok(offset + length <= object.size)
        return { ...object, async arrayBuffer() { return new ArrayBuffer(length) } }
      },
      async list() { return { objects: [...objects.values()], truncated: false } },
      async delete(key) { objects.delete(key) },
    },
  }

  const client = {
    async requestUpload(rawUrl: string, init?: RequestInit) {
      const target = new URL(rawUrl)
      if (target.pathname.endsWith("generateIds")) return Response.json({ ids: ["drive-id"] })
      if (target.pathname === "/drive/v3/files/drive-id") {
        return file ? Response.json({ ...file, size: wrongSize ? "123" : file.size }) : new Response(null, { status: 404 })
      }
      if (target.pathname === "/drive/v3/files") return Response.json({ files: file ? [file] : [] })
      if (init?.method === "POST") {
        driveMetadata = JSON.parse(String(init.body))
        return new Response(null, { headers: { location: url } })
      }
      const range = new Headers(init?.headers).get("content-range")!
      if (range.startsWith("bytes */")) {
        if (file) return Response.json({ id: "drive-id" })
        return new Response(null, { status: 308, headers: { range: "bytes=0-" + (committed - 1) } })
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)!
      const [, start, end, total] = match.map(Number)
      assert.equal(start, committed)
      writes.push(start)
      committed = end + 1
      if (lost) {
        lost = false
        throw new Error("lost response after Google accepted the chunk")
      }
      if (committed === total) {
        file = { ...driveMetadata, size: String(total) }
        return Response.json({ id: "drive-id" })
      }
      return new Response(null, { status: 308, headers: { range: "bytes=0-" + end } })
    },
  } as GoogleDriveClient

  return {
    env, client, objects, queue, writes,
    setQueueFailure(fail: boolean) { sendFails = fail },
    loseCompleteResponse() { loseComplete = true },
    setWrongSize(wrong: boolean) { wrongSize = wrong },
    completeCalls: () => completeCalls,
    abortCalls: () => abortCalls,
  }
}

function calls(coordinator: S3Uploads) {
  return async <T>(action: string, params: object, data?: Uint8Array): Promise<{ response: Response; body: T }> => {
    const request = new Request("https://upload.internal/" + action, {
      method: "POST",
      ...(data ? { headers: { "x-upload-parameters": encodeURIComponent(JSON.stringify(params)) }, body: data as Uint8Array<ArrayBuffer> }
        : { body: JSON.stringify(params) }),
    })
    const response = await coordinator.fetch(request)
    return { response, body: await response.json() as T }
  }
}

test("legacy failed jobs release both locks without discarding staged data", async () => {
  const storage = memoryStorage()
  const first = new UploadLedger(storage)
  const failed = { ...newJob("/drive/test.bin", 3), state: "failed" as const }
  first.insert(failed)
  storage.sql.exec("DROP INDEX s3_active_path")
  storage.sql.exec("DROP INDEX s3_active_destination")
  storage.sql.exec("CREATE UNIQUE INDEX s3_active_path ON s3_jobs(path) WHERE state NOT IN ('done','aborted')")
  storage.sql.exec("CREATE UNIQUE INDEX s3_active_destination ON s3_jobs(destination) WHERE state NOT IN ('done','aborted')")
  const ledger = new UploadLedger(storage)
  const replacement = newJob(failed.path)
  ledger.insert(replacement)
  assert.equal(new UploadLedger(storage).activePath(failed.path)?.id, replacement.id)
  assert.equal(ledger.reserved(), 3)
  assert.throws(() => ledger.insert({ ...failed, state: "staged" }), { code: "OperationAborted" })
  const aliased = { ...replacement, id: crypto.randomUUID(), path: "/alias/test.bin" }
  assert.throws(() => ledger.insert(aliased), { code: "OperationAborted" })
})

test("discard checks the exact failed object's identity and releases only its reservation", async (t) => {
  const state = { storage: memoryStorage() }
  const fake = fakeServices()
  const ledger = new UploadLedger(state.storage)
  const failed = { ...newJob("/drive/test.bin", 3), state: "failed" as const, size: 3, version: "v1" }
  const other = { ...failed, ...newJob("/drive/other.bin", 4), state: "failed" as const, size: 4 }
  const key = STAGING_PREFIX + failed.id
  const object = { key, size: 3, etag: "etag", version: "v1", customMetadata: { openlistUpload: failed.id } }
  const otherKey = STAGING_PREFIX + other.id
  ledger.insert(failed)
  ledger.insert(other)
  fake.objects.set(otherKey, { ...object, key: otherKey, size: 4, customMetadata: { openlistUpload: other.id } })
  const request = calls(new S3Uploads(state, fake.env, async () => fake.client))
  const payload = newJob(failed.path)
  const replacement = await request<UploadStatus>("create", payload)
  assert.equal(replacement.response.status, 200)
  assert.equal((await request("discard", { id: replacement.body.id })).response.status, 409)
  assert.equal((await request("retry", { ...failed })).response.status, 409)

  for (const foreign of [
    { ...object, customMetadata: { openlistUpload: other.id } },
    { ...object, version: "v2" },
    { ...object, size: 4 },
  ]) {
    fake.objects.set(key, foreign)
    assert.equal((await request("discard", { id: failed.id })).response.status, 409)
    assert.equal(fake.objects.get(key), foreign)
    assert.equal(ledger.reserved(), 7)
  }

  fake.objects.set(key, object)
  const remove = fake.env.R2.delete
  const deleteMock = t.mock.method(fake.env.R2, "delete", async () => { throw new Error("R2 unavailable") })
  assert.equal((await request("discard", { id: failed.id })).response.status, 503)
  assert.equal(ledger.reserved(), 7)
  deleteMock.mock.restore()
  assert.equal(fake.env.R2.delete, remove)
  const discarded = await request<UploadStatus>("discard", { id: failed.id })
  assert.equal(discarded.response.status, 200)
  assert.equal(discarded.body.state, "aborted")
  assert.equal(discarded.body.bytes, 0)
  assert.equal((await request("discard", { id: failed.id })).response.status, 200)
  assert.equal(fake.objects.has(key), false)
  assert.equal(fake.objects.has(otherKey), true)
  assert.equal(ledger.reserved(), 4)
  assert.equal(ledger.activePath(failed.path)?.id, replacement.body.id)
})

test("failed staging is automatically discarded 24 hours after failure, never before", async (t) => {
  const state = { storage: memoryStorage() }
  const fake = fakeServices()
  fake.env.S3_FAILED_RETENTION_HOURS = "24"
  const ledger = new UploadLedger(state.storage)
  const clockStart = Date.now()
  let clock = clockStart
  t.mock.method(Date, "now", () => clock)
  const failed = { ...newJob("/drive/expired-failure.bin", 3), state: "failed" as const, size: 3, version: "v1" }
  failed.created = clockStart - 3 * 24 * 60 * 60_000
  failed.updated = clockStart
  ledger.insert(failed)
  const key = STAGING_PREFIX + failed.id
  fake.objects.set(key, {
    key, size: 3, version: "v1", etag: "etag",
    customMetadata: { openlistUpload: failed.id },
  })
  const coordinator = new S3Uploads(state, fake.env, async () => fake.client)
  clock += 24 * 60 * 60_000 - 1
  await coordinator.alarm()
  assert.ok(fake.objects.has(key), "must retain the complete R2 object before 24 hours")
  assert.equal(ledger.job(failed.id)?.state, "failed")
  assert.equal(ledger.reserved(), 3)

  clock += 2
  await coordinator.alarm()
  assert.equal(fake.objects.has(key), false)
  assert.equal(ledger.job(failed.id)?.state, "aborted")
  assert.equal(ledger.reserved(), 0)
})

test("automatic failed cleanup retains a mismatched object and disables unsafe retention settings", async (t) => {
  const state = { storage: memoryStorage() }
  const fake = fakeServices()
  const ledger = new UploadLedger(state.storage)
  let clock = Date.now()
  t.mock.method(Date, "now", () => clock)
  const job = { ...newJob("/drive/foreign-object.bin", 3), state: "failed" as const, size: 3, version: "v1" }
  ledger.insert(job)
  const key = STAGING_PREFIX + job.id
  const wrong = {
    key, size: 3, etag: "etag", version: "v2",
    customMetadata: { openlistUpload: job.id },
  }
  fake.objects.set(key, wrong)
  const coordinator = new S3Uploads(state, fake.env, async () => fake.client)
  clock += 25 * 60 * 60_000
  fake.env.S3_FAILED_RETENTION_HOURS = "23"
  await coordinator.alarm()
  assert.equal(ledger.job(job.id)?.state, "failed")
  fake.env.S3_FAILED_RETENTION_HOURS = "24"
  await coordinator.alarm()
  assert.equal(ledger.job(job.id)?.state, "failed")
  assert.equal(fake.objects.get(key), wrong)
  assert.equal(ledger.reserved(), 3)
})

test("five failed Google Drive retries discard only the matching R2 object immediately", async (t) => {
  const state = { storage: memoryStorage() }
  const fake = fakeServices()
  const ledger = new UploadLedger(state.storage)
  let clock = Date.now()
  t.mock.method(Date, "now", () => clock)
  const job = { ...newJob("/drive/failed-five-retries.bin", 3), state: "staged" as const, size: 3, etag: "etag", version: "v1" }
  ledger.insert(job)
  const key = STAGING_PREFIX + job.id
  fake.objects.set(key, { key, size: 3, etag: "etag", version: "v1",
    customMetadata: { openlistUpload: job.id } })
  fake.objects.set("existing-business-data", { key: "existing-business-data", size: 9,
    etag: "business", version: "v2" })
  t.mock.method(fake.client, "requestUpload", async () => {
    throw new Error("Google Drive unavailable")
  })
  const coordinator = new S3Uploads(state, fake.env, async () => fake.client)
  const request = calls(coordinator)
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await request("step", { id: job.id })
    assert.equal(response.response.status, 200)
    if (attempt < 6) {
      assert.equal(ledger.job(job.id)?.state, "staged")
      assert.equal(ledger.job(job.id)?.attempts, attempt)
      assert.ok(fake.objects.has(key))
      assert.equal(ledger.reserved(), 3)
    }
    clock += 60 * 60_000
  }
  assert.equal(ledger.job(job.id)?.state, "aborted")
  assert.equal(ledger.job(job.id)?.bytes, 0)
  assert.equal(fake.objects.has(key), false)
  assert.ok(fake.objects.has("existing-business-data"))
  assert.equal(ledger.reserved(), 0)
})

test("Drive retry exhaustion keeps R2 reservation when its identity cannot be verified", async (t) => {
  const state = { storage: memoryStorage() }
  const fake = fakeServices()
  const ledger = new UploadLedger(state.storage)
  let clock = Date.now()
  t.mock.method(Date, "now", () => clock)
  const job = { ...newJob("/drive/retain-mismatch.bin", 3), state: "staged" as const, size: 3, etag: "etag", version: "v1" }
  ledger.insert(job)
  const key = STAGING_PREFIX + job.id
  const foreign = { key, size: 3, etag: "etag", version: "v2",
    customMetadata: { openlistUpload: job.id } }
  fake.objects.set(key, foreign)
  t.mock.method(fake.client, "requestUpload", async () => {
    throw new Error("Google Drive unavailable")
  })
  const coordinator = new S3Uploads(state, fake.env, async () => fake.client)
  const request = calls(coordinator)
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal((await request("step", { id: job.id })).response.status, 200)
    clock += 60 * 60_000
  }
  assert.equal(ledger.job(job.id)?.state, "failed")
  assert.equal(ledger.job(job.id)?.attempts, 6)
  assert.equal(fake.objects.get(key), foreign)
  assert.equal(ledger.reserved(), 3)
})

test("S3 discard requires an administrator JWT and passes a single ID to the coordinator", async () => {
  const received: unknown[] = []
  const env = {
    ...fakeServices().env,
    JWT_SECRET: "only-for-s3-discard-regression",
    S3_UPLOADS: {
      idFromName: () => "coordinator",
      get: () => ({
        async fetch(request: Request) {
          assert.equal(new URL(request.url).pathname, "/discard")
          received.push(await request.json())
          return Response.json({ state: "aborted", bytes: 0 })
        },
      }),
    },
  }
  const users = [
    { id: 1, username: "admin-test", role: 2 },
    { id: 7, username: "owner-test", role: 0 },
  ]
  assert.equal(await saveDb({ users, settings: [], storages: [] }, env, { force: true }), true)
  const app = new Hono().route("/s3", s3Router)
  const id = crypto.randomUUID()
  const url = "/s3?openlist-discard&uploadId=" + id
  const post = (path: string, bearer?: string) => app.request(path, {
    method: "POST",
    headers: bearer ? { Authorization: "Bearer " + bearer } : {},
  }, env)
  const [admin, owner] = await Promise.all(users.map(({ id }) => sign({ id }, env.JWT_SECRET, "HS256")))
  assert.equal((await post(url)).status, 403)
  assert.equal((await post(url, owner)).status, 403)
  assert.equal((await post(url + "&uploadId=" + crypto.randomUUID(), admin)).status, 400)
  assert.equal((await post(url, admin)).status, 200)
  assert.deepEqual(received, [{ id }])
})

test("multipart retries, duplicate Complete, queue redelivery, resume and verified deletion", async (t) => {
  const state = { storage: memoryStorage() }
  const fake = fakeServices()
  const make = () => new S3Uploads(state, fake.env, async () => fake.client)
  let coordinator = make()
  let request = calls(coordinator)
  let clock = Date.now()
  t.mock.method(Date, "now", () => clock)
  const payload = newJob("/drive/new.bin")
  const created = await request<UploadStatus>("create", payload)
  assert.equal(created.response.status, 200)
  const args = { owner: 7, path: payload.path, id: created.body.id }
  const bytes = new Uint8Array(5 * MiB)
  const checksum = createHash("md5").update(bytes).digest("hex")

  const sendPart = (number: number, md5 = checksum) =>
    request<Part>("part", { ...args, number, size: bytes.byteLength, checksums: { md5 } }, bytes)
  const parts = await Promise.all([1, 2, 3, 4].map((number) => sendPart(number)))
  for (const part of parts) assert.equal(part.response.status, 200)
  assert.equal((await sendPart(2, "bad")).response.status, 400)
  const replacement = await sendPart(2)
  assert.equal(replacement.body.etag, parts[1].body.etag)
  const manifest = parts.map(({ body: { partNumber, etag } }) => ({ partNumber, etag }))
  const listed = await request<Part[]>("parts", args)
  assert.deepEqual(listed.body.map(({ partNumber }) => partNumber), [1, 2, 3, 4])
  assert.equal((await request("parts", { ...args, owner: 9 })).response.status, 404)

  fake.setQueueFailure(true)
  const complete = await request<UploadStatus>("complete", { ...args, manifest })
  assert.equal(complete.body.size, 20 * MiB)
  assert.equal(complete.body.state, "staged")
  assert.equal(fake.queue.length, 0)
  assert.equal((await request<UploadStatus>("complete", { ...args, manifest })).body.etag, complete.body.etag)
  assert.equal((await request("complete", { ...args, manifest: manifest.slice(1) })).response.status, 400)
  assert.equal(fake.completeCalls(), 1)

  fake.setQueueFailure(false)
  clock += 31_000
  await coordinator.alarm()
  assert.deepEqual(fake.queue, [args.id])
  await request("step", args)
  assert.deepEqual(fake.writes, [0])
  assert.ok(fake.objects.has(STAGING_PREFIX + args.id))

  coordinator = make()
  request = calls(coordinator)
  clock += 31_000
  fake.setWrongSize(true)
  await request("step", args)
  assert.deepEqual(fake.writes, [0, 16 * MiB])
  assert.ok(fake.objects.has(STAGING_PREFIX + args.id))

  fake.setWrongSize(false)
  clock += 61_000
  await request("step", args)
  await request("step", args)
  await request("step", args)
  assert.deepEqual(fake.writes, [0, 16 * MiB])
  assert.equal((await request<UploadStatus>("status", args)).body.state, "done")
  assert.equal(fake.objects.has(STAGING_PREFIX + args.id), false)
  assert.equal((await request<{ reserved: number }>("quota", {})).body.reserved, 0)
})

test("abort releases incomplete multipart reservations and does not touch existing R2 data", async (t) => {
  const fake = fakeServices()
  fake.objects.set("existing-business-data", { key: "existing-business-data", size: 3 * MiB, etag: "existing", version: "v1" })
  const storage = memoryStorage()
  const coordinator = new S3Uploads({ storage }, fake.env, async () => fake.client)
  const req = calls(coordinator)
  let clock = Date.now()
  t.mock.method(Date, "now", () => clock)
  const one = newJob("/drive/abort.bin")
  const two = newJob("/drive/expire.bin")
  for (const job of [one, two]) {
    const created = (await req<UploadStatus>("create", job)).body
    const args = { path: job.path, owner: job.owner, id: created.id }
    assert.equal((await req("part", { ...args, number: 1, size: 3 }, new Uint8Array([1, 2, 3]))).response.status, 200)
    if (job === one) {
      assert.equal((await req("abort", args)).response.status, 200)
      assert.equal((await req("abort", args)).response.status, 200)
    }
  }
  clock += 24 * 60 * 60_000 + 1000
  await coordinator.alarm()
  assert.equal(fake.abortCalls(), 2)
  const quota = (await req<{ reserved: number; externalObjects: number }>("quota", {})).body
  assert.equal(quota.reserved, 0)
  assert.equal(quota.externalObjects, 3 * MiB)
  assert.ok(fake.objects.has("existing-business-data"))
})

test("the coordinator accepts a streamed 50 MiB part and accounts concurrent requests atomically", async () => {
  const state = { storage: memoryStorage() }
  const fake = fakeServices()
  fake.env.S3_EXTERNAL_MULTIPART_BYTES = String(MAX_BUCKET_BYTES - S3_CHUNK_SIZE)
  const coordinator = new S3Uploads(state, fake.env, async () => fake.client)
  const req = calls(coordinator)
  const args = await Promise.all(["one", "two"].map(async (name) => {
    const job = newJob("/drive/" + name)
    const created = (await req<UploadStatus>("create", job)).body
    return { owner: job.owner, path: job.path, id: created.id }
  }))
  const part = async (job: typeof args[number]) => {
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < S3_CHUNK_SIZE) {
          controller.enqueue(new Uint8Array(MiB))
          sent += MiB
        } else controller.close()
      },
    })
    const params = encodeURIComponent(JSON.stringify({ ...job, size: S3_CHUNK_SIZE, number: 1 }))
    const request = new Request("https://upload.internal/part", {
      method: "POST", body, headers: { "x-upload-parameters": params },
      ...{ duplex: "half" },
    })
    return coordinator.fetch(request)
  }
  const responses = await Promise.all(args.map(part))
  assert.deepEqual(responses.map((res) => res.status).sort(), [200, 503])
  for (const argsForJob of args) assert.equal((await req("abort", argsForJob)).response.status, 200)
  assert.equal((await req<{ reserved: number }>("quota", {})).body.reserved, 0)
})

test("zero-byte signed PUT can stage an empty object with the correct digest", async () => {
  const fake = fakeServices()
  const req = calls(new S3Uploads({ storage: memoryStorage() }, fake.env, async () => fake.client))
  const job = newJob("/drive/empty.txt")
  const response = await req<UploadStatus>("put", {
    ...job, size: 0, checksums: { md5: createHash("md5").digest("hex") },
  })
  assert.equal(response.response.status, 200)
  assert.equal(response.body.size, 0)
  assert.equal(response.body.state, "staged")
  assert.equal(fake.objects.get(STAGING_PREFIX + response.body.id)?.size, 0)
})

test("a completed R2 object is recovered after a lost response and is never treated as abandoned", async (t) => {
  const fake = fakeServices()
  const state = { storage: memoryStorage() }
  const start = () => new S3Uploads(state, fake.env, async () => fake.client)
  let coordinator = start()
  const req = calls(coordinator)
  let clock = Date.now()
  t.mock.method(Date, "now", () => clock)
  const path = "/drive/undelivered-complete.bin"
  const { body: job } = await req<UploadStatus>("create", newJob(path))
  const args = { path, owner: 7, id: job.id }
  const { body: part } = await req<Part>("part", { ...args, number: 1, size: 3 }, new Uint8Array([1, 2, 3]))
  fake.loseCompleteResponse()
  const manifest = [{ partNumber: 1, etag: part.etag }]
  assert.equal((await req("complete", { ...args, manifest })).response.status, 503)
  assert.ok(fake.objects.has(STAGING_PREFIX + job.id))
  assert.equal(fake.queue.length, 0)
  assert.equal((await req<UploadStatus>("status", args)).body.state, "sealing")

  coordinator = start()
  clock += 61_000
  await coordinator.alarm()
  assert.deepEqual(fake.queue, [job.id])
  assert.equal(fake.completeCalls(), 1)
  const result = await calls(coordinator)<UploadStatus>("complete", { ...args, manifest })
  assert.equal(result.body.state, "staged")
  assert.equal(result.body.size, 3)
  assert.equal((await calls(coordinator)("abort", args)).response.status, 404)
  assert.ok(fake.objects.has(STAGING_PREFIX + job.id))
})

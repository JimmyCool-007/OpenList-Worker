import { DriveUploadError } from "../drivers/google_drive/resumable"
import { UploadLedger } from "../internal/s3/ledger"
import type { LedgerStorage, UploadJob } from "../internal/s3/ledger"
import { storeEmptyUpload, writeUploadBody } from "../internal/s3/body"
import type { BodyChecksums } from "../internal/s3/body"
import {
  fail, JOB_ID, MAX_FILE_SIZE, MIN_PART_SIZE, S3_CHUNK_SIZE, S3Failure, STAGING_PREFIX,
} from "../internal/s3/protocol"
import type {
  Manifest, StagedObject, UploadEnv, UploadMetadata, UploadScope, UploadStatus, UploadTarget,
} from "../internal/s3/protocol"
import { isJobObject, stagedKey, transferChunk } from "../internal/s3/transfer"
import type { ResolveUploadClient } from "../internal/s3/transfer"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const AUDIT_INTERVAL = 5 * MINUTE
const AUDIT_MAX_AGE = 30 * MINUTE
const REDELIVERY = 5 * MINUTE
const RETENTION = 7 * DAY
const MAX_ATTEMPTS = 10

type Parameters = UploadScope & {
  id?: string
  target?: UploadTarget
  metadata?: UploadMetadata
  size?: number
  number?: number
  checksums?: BodyChecksums
  manifest?: Manifest
  expectedSize?: number
  after?: string
  afterId?: string
  limit?: number
}

function statusOf(job: UploadJob): UploadStatus {
  const { id, state, bytes, size, etag, offset, updated, driveId, metadata, error } = job
  return { id, state, bytes, size, etag, offset, updated, driveId, metadata, error }
}

function missingR2Upload(error: unknown) {
  if (!(error instanceof Error)) return false
  return (error as Error & { code?: number | string }).code === 10024 ||
    /\(10024\)|NoSuchUpload|specified multipart upload does not exist/i.test(error.message)
}

function invalidBody(error: unknown) {
  return error instanceof S3Failure && ["BadDigest", "IncompleteBody"].includes(error.code)
}

export class S3Uploads {
  private readonly ledger: UploadLedger
  private readonly active = new Map<string, Set<number>>()
  private scan?: Promise<void>
  private transferring = false

  constructor(
    private readonly state: { storage: LedgerStorage },
    private readonly env: UploadEnv,
    private readonly resolveUploadClient: ResolveUploadClient = async (...args) =>
      (await import("../internal/s3/target")).loadUploadTarget(...args),
  ) {
    this.ledger = new UploadLedger(state.storage)
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const encoded = request.headers.get("x-upload-parameters")
      const raw = encoded ? JSON.parse(decodeURIComponent(encoded)) : await request.json()
      const params = raw as Parameters
      const action = new URL(request.url).pathname
      switch (action) {
        case "/create":
        case "/put":
          return Response.json(await this.create(params, action === "/put", encoded ? request.body : null))
        case "/step":
          if (params.id && JOB_ID.test(params.id)) await this.step(params.id)
          return Response.json({ ok: true })
        case "/discard": {
          const id = params.id
          if (!id || !JOB_ID.test(id)) fail("NoSuchUpload", "Upload was not found", 404)
          return Response.json(await this.exclusive(id, 0, () => this.discardFailed(id)))
        }
        case "/head": {
          const job = this.ledger.activePath(params.path)
          return Response.json(job?.owner === params.owner && job.etag ? statusOf(job) : null)
        }
        case "/uploads":
          return Response.json(this.ledger.openUploads(params.owner, params.path, params.after!, params.afterId!, params.limit!))
        case "/status": {
          const job = params.id ? this.owned(params) : this.ledger.latest(params)
          if (!job || job.owner !== params.owner) fail("NoSuchUpload", "Upload was not found", 404)
          return Response.json(statusOf(job))
        }
        case "/quota": {
          await this.ensureAlarm()
          await this.auditPage()
          const audit = this.ledger.audit()
          return Response.json({
            externalObjects: audit.bytes,
            externalMultipart: this.externalMultipart(),
            reserved: this.ledger.reserved(),
            auditedAt: audit.finished,
          })
        }
      }
      const job = this.owned(params)
      switch (action) {
        case "/part":
          return Response.json(await this.part(job, params, request.body))
        case "/parts":
          if (job.state !== "open") fail("NoSuchUpload", "No open multipart upload", 404)
          return Response.json(this.ledger.parts(job.id).filter((part) => !part.pending))
        case "/complete":
          return Response.json(await this.exclusive(job.id, 0, () => this.complete(job, params.manifest!, params.expectedSize)))
        case "/abort":
          await this.exclusive(job.id, 0, () => this.abort(job))
          return Response.json({ ok: true })
        case "/retry":
          return Response.json(await this.exclusive(job.id, 0, async () => {
            if (job.state !== "failed" && job.state !== "staged" && job.state !== "verified") {
              fail("InvalidRequest", "Only staged or failed transfers can be retried", 409)
            }
            if (!job.etag) {
              const object = await this.env.R2.head(stagedKey(job))
              if (!object || !isJobObject(job, object)) {
                fail("InvalidRequest", "Staged object requires operator inspection", 409)
              }
              job.etag = object.etag.replace(/^"|"$/g, "")
              job.version = object.version
            }
            job.state = job.driveId && job.offset === job.size && !job.session ? "verified" : "staged"
            job.attempts = 0
            job.error = undefined
            job.next = 0
            job.sent = 0
            this.ledger.insert(job)
            await this.ensureAlarm()
            await this.dispatch(job)
            return statusOf(job)
          }))
        default:
          fail("NotImplemented", "Unknown upload operation", 501)
      }
    } catch (error) {
      if (error instanceof S3Failure) {
        return Response.json({ code: error.code, message: error.message }, { status: error.status })
      }
      console.error("[s3-upload] coordinator operation failed", error instanceof Error ? error.name : "unknown")
      return Response.json({ code: "ServiceUnavailable", message: "Upload operation failed. Retry later." }, { status: 503 })
    }
  }

  private owned(params: Parameters): UploadJob {
    const job = params.id && JOB_ID.test(params.id) ? this.ledger.job(params.id) : undefined
    if (!job || job.owner !== params.owner || job.path !== params.path) {
      fail("NoSuchUpload", "Upload was not found", 404)
    }
    return job
  }

  private async exclusive<T>(id: string, part: number, operation: () => Promise<T>): Promise<T> {
    const active = this.active.get(id) ?? new Set<number>()
    if (active.has(0) || active.has(part) || (part === 0 && active.size)) {
      fail("OperationAborted", "Another operation is running for this upload", 409)
    }
    active.add(part)
    this.active.set(id, active)
    try {
      return await operation()
    } finally {
      active.delete(part)
      if (!active.size) this.active.delete(id)
    }
  }

  private async ensureAlarm() {
    const at = Date.now() + 30_000
    const scheduled = await this.state.storage.getAlarm()
    if (scheduled === null || scheduled > at) await this.state.storage.setAlarm(at)
  }

  private externalMultipart() {
    const value = this.env.S3_EXTERNAL_MULTIPART_BYTES ?? "0"
    const bytes = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes)) {
      fail("ServiceUnavailable", "Invalid external multipart quota configuration", 503)
    }
    return bytes
  }

  private async auditPage() {
    const audit = this.ledger.audit()
    if (audit.started === undefined && Date.now() - audit.finished < AUDIT_INTERVAL) return
    if (!this.scan) {
      this.scan = this.readAuditPage().finally(() => { this.scan = undefined })
    }
    await this.scan
  }

  private async readAuditPage() {
    const current = this.ledger.audit()
    const page = await this.env.R2.list({
      limit: 1000, cursor: current.cursor, include: ["customMetadata"],
    })
    let sum = current.scanning ?? 0
    for (const object of page.objects) {
      const id = object.key.startsWith(STAGING_PREFIX) ? object.key.slice(STAGING_PREFIX.length) : ""
      const job = JOB_ID.test(id) ? this.ledger.job(id) : undefined
      if (!job || !isJobObject(job, object) || job.bytes < object.size) sum += object.size
    }
    this.ledger.saveAudit(page.truncated && page.cursor
      ? { ...current, cursor: page.cursor, scanning: sum, started: current.started ?? Date.now() }
      : { bytes: sum, finished: Date.now() })
  }

  private async externalBytes() {
    const before = this.ledger.audit()
    if (!before.finished || Date.now() - before.finished > AUDIT_MAX_AGE) await this.auditPage()
    const audit = this.ledger.audit()
    if (!audit.finished || Date.now() - audit.finished > AUDIT_MAX_AGE) {
      fail("ServiceUnavailable", "R2 inventory is not current. Retry after it completes.", 503)
    }
    return Math.max(audit.bytes, audit.scanning ?? 0) + this.externalMultipart()
  }

  private async create(params: Parameters, single: boolean, body: ReadableStream<Uint8Array> | null) {
    if (this.env.S3_UPLOAD_MODE !== "enabled") fail("ServiceUnavailable", "New staging uploads are paused", 503)
    const id = crypto.randomUUID()
    const now = Date.now()
    const job: UploadJob = {
      id, owner: params.owner, path: params.path, target: params.target!, metadata: params.metadata!,
      state: single ? "putting" : "creating", bytes: single ? params.size! : 0,
      size: single ? params.size : undefined, offset: 0, attempts: 0, next: 0, sent: 0,
      created: now, updated: now,
    }
    const options = {
      httpMetadata: { contentType: job.metadata.contentType },
      customMetadata: { openlistUpload: id },
      storageClass: "Standard",
    }
    return this.exclusive(id, 0, async () => {
      await this.ensureAlarm()
      this.ledger.insert(job, await this.externalBytes())
      await this.state.storage.sync()
      if (single) {
        const key = stagedKey(job)
        const putOptions = { ...options, onlyIf: { etagDoesNotMatch: "*" } }
        try {
          const object = job.size === 0
            ? await storeEmptyUpload(body, params.checksums ?? {}, () => this.env.R2.put(key, new Uint8Array(), putOptions))
            : await writeUploadBody(body, job.size!, params.checksums ?? {}, (stream) => this.env.R2.put(key, stream, putOptions))
          if (!object) fail("OperationAborted", "R2 staging object already exists", 409)
          await this.stage(job, object)
        } catch (error) {
          if (invalidBody(error)) {
            job.state = "aborted"
            job.bytes = 0
            this.ledger.save(job)
          }
          throw error
        }
      } else {
        const upload = await this.env.R2.createMultipartUpload(stagedKey(job), options)
        job.r2UploadId = upload.uploadId
        job.state = "open"
        this.ledger.save(job)
      }
      return statusOf(job)
    })
  }

  private multipart(job: UploadJob) {
    return this.env.R2.resumeMultipartUpload(stagedKey(job), job.r2UploadId!)
  }

  private async part(job: UploadJob, params: Parameters, body: ReadableStream<Uint8Array> | null) {
    const number = params.number!
    const size = params.size!
    if (job.state !== "open") fail("NoSuchUpload", "No open multipart upload", 404)
    return this.exclusive(job.id, number, async () => {
      const previous = this.ledger.reservePart(job.id, number, size, await this.externalBytes())
      await this.state.storage.sync()
      const result = await writeUploadBody(body, size, params.checksums ?? {}, (stream) =>
        this.multipart(job).uploadPart(number, stream),
      ).catch((error) => {
        if (invalidBody(error)) this.ledger.releaseFailedPart(job.id, number, previous)
        throw error
      })
      const part = { partNumber: number, etag: result.etag.replace(/^"|"$/g, ""), size, date: Date.now() }
      this.ledger.commitPart(job.id, part)
      return part
    })
  }

  private async stage(job: UploadJob, object: StagedObject) {
    const matches = isJobObject(job, object)
    job.state = matches ? "staged" : "failed"
    job.bytes = matches ? object.size : Math.max(job.bytes, object.size)
    if (matches) {
      job.etag = object.etag.replace(/^"|"$/g, "")
      job.version = object.version
      if (!job.r2UploadId && /^[0-9a-f]{32}$/.test(job.etag)) job.metadata.md5 ??= job.etag
    } else {
      job.error = "Completed R2 object does not match the upload"
    }
    job.updated = Date.now()
    this.ledger.closeParts(job)
    if (!matches) fail("InternalError", job.error!, 500)
    await this.dispatch(job)
  }

  private async seal(job: UploadJob) {
    const key = stagedKey(job)
    let object = await this.env.R2.head(key)
    if (!object) {
      await this.state.storage.sync()
      await this.multipart(job).complete(job.manifest!)
      object = await this.env.R2.head(key)
      if (!object) fail("ServiceUnavailable", "Completed R2 metadata is unavailable. Retry Complete.", 503)
    }
    await this.stage(job, object)
  }

  private async discardFailed(id: string) {
    const job = this.ledger.job(id)
    if (!job) fail("NoSuchUpload", "Upload was not found", 404)
    if (job.state === "aborted") return statusOf(job)
    if (job.state !== "failed") fail("InvalidRequest", "Only failed uploads can be discarded", 409)

    const key = stagedKey(job)
    const object = await this.env.R2.head(key)
    if (object) {
      if (object.key !== key || !isJobObject(job, object)) {
        fail("InvalidRequest", "R2 object identity does not match the job. Nothing was discarded.", 409)
      }
      await this.env.R2.delete(key)
      if (await this.env.R2.head(key)) fail("OperationAborted", "R2 object still exists. Retry after inspection.", 409)
    }

    job.state = "aborted"
    job.bytes = 0
    job.etag = undefined
    job.version = undefined
    job.manifest = undefined
    job.session = undefined
    job.updated = Date.now()
    this.ledger.closeParts(job)
    await this.state.storage.sync()
    console.info("[s3-upload] administrator discarded failed upload", id)
    return statusOf(job)
  }

  private async complete(job: UploadJob, manifest: Manifest, expectedSize?: number) {
    if ((job.etag || job.state === "sealing") && JSON.stringify(job.manifest) !== JSON.stringify(manifest)) {
      fail("InvalidPart", "Retry Complete with the original part list")
    }
    if (job.etag) return statusOf(job)
    if (job.state === "open") {
      const parts = new Map(this.ledger.parts(job.id).map((part) => [part.partNumber, part]))
      const selected = manifest.map(({ partNumber, etag }) => {
        const part = parts.get(partNumber)
        if (!part || part.pending || part.etag !== etag) fail("InvalidPart", "Part is missing or its ETag differs")
        return part
      })
      const first = selected[0]
      const last = selected[selected.length - 1]
      if (selected.slice(0, -1).some((part) => part.size < MIN_PART_SIZE)) {
        fail("EntityTooSmall", "Non-final parts must be at least 5 MiB")
      }
      if (selected.slice(0, -1).some((part) => part.size !== first.size) || last.size > first.size) {
        fail("InvalidPart", "R2 requires uniformly sized parts with a final part no larger than the others")
      }
      job.size = selected.reduce((sum, part) => sum + part.size, 0)
      if (job.size > MAX_FILE_SIZE) fail("EntityTooLarge", "Object exceeds 5000000000 bytes")
      if (expectedSize !== undefined && expectedSize !== job.size) fail("InvalidRequest", "Completed parts do not match the declared object size")
      job.manifest = manifest
      job.state = "sealing"
      job.updated = Date.now()
      this.ledger.save(job)
    }
    if (job.state !== "sealing") fail("NoSuchUpload", "No open multipart upload", 404)
    await this.seal(job)
    return statusOf(job)
  }

  private async abort(job: UploadJob) {
    if (job.state === "aborted") return
    if (!["creating", "putting", "open", "sealing", "aborting"].includes(job.state)) {
      fail("NoSuchUpload", "No incomplete upload", 404)
    }
    const key = stagedKey(job)
    if (job.state === "sealing" || job.state === "putting" || job.state === "aborting") {
      const object = await this.env.R2.head(key)
      if (object) {
        await this.stage(job, object)
        fail("NoSuchUpload", "Upload was already completed", 404)
      }
    }
    job.state = "aborting"
    this.ledger.save(job)
    await this.state.storage.sync()
    if (job.r2UploadId) {
      try {
        await this.multipart(job).abort()
      } catch (error) {
        if (!missingR2Upload(error)) throw error
      }
      const object = await this.env.R2.head(key)
      if (object) {
        await this.stage(job, object)
        fail("NoSuchUpload", "Upload was already completed", 404)
      }
    }
    job.state = "aborted"
    job.bytes = 0
    job.updated = Date.now()
    job.manifest = undefined
    this.ledger.closeParts(job)
  }

  private async dispatch(job: UploadJob) {
    job.sent = Date.now() + REDELIVERY
    this.ledger.save(job)
    try {
      await this.state.storage.sync()
      await this.env.UPLOAD_QUEUE.send({ version: 1, id: job.id })
    } catch {
      job.sent = 0
      job.next = Math.max(job.next, Date.now() + 30_000)
      this.ledger.save(job)
      console.warn("[s3-upload] queue dispatch pending", job.id)
    }
  }

  private async step(id: string) {
    const job = this.ledger.job(id)
    if (!job || !["staged", "verified"].includes(job.state) || job.next > Date.now()) return
    if (this.transferring || this.active.has(id)) {
      fail("SlowDown", "Upload coordinator is already transferring a chunk", 503)
    }
    this.transferring = true
    try {
      await this.exclusive(id, 0, async () => {
        try {
          await transferChunk(this.env, this.ledger, job, this.resolveUploadClient)
          job.error = undefined
          job.attempts = 0
          job.next = 0
        } catch (error) {
          job.attempts++
          job.error = error instanceof DriveUploadError || error instanceof S3Failure
            ? error.message : "Transfer or verification failed"
          job.next = Date.now() + Math.min(60 * MINUTE, 30_000 * 2 ** (job.attempts - 1))
          if (job.attempts >= MAX_ATTEMPTS) job.state = "failed"
          console.warn("[s3-upload] transfer retry", job.id, job.attempts, job.error)
        }
        job.updated = Date.now()
        job.sent = 0
        this.ledger.save(job)
        if (job.state === "done") console.info("[s3-upload] verified and removed staging object", job.id)
        if ((job.state === "staged" || job.state === "verified") && !job.next) await this.dispatch(job)
      })
    } finally {
      this.transferring = false
    }
  }

  async alarm() {
    // Install the next alarm before I/O so an interrupted invocation cannot lose the outbox.
    await this.state.storage.setAlarm(Date.now() + (this.ledger.hasWork() ? 30_000 : AUDIT_INTERVAL))
    try {
      await this.auditPage()
    } catch {
      console.warn("[s3-upload] R2 inventory audit deferred")
    }

    const now = Date.now()
    for (const { id } of this.ledger.unsettled(now - MINUTE, now - DAY)) {
      if (this.active.has(id)) continue
      await this.exclusive(id, 0, async () => {
        const job = this.ledger.job(id)
        if (!job || !["sealing", "putting"].includes(job.state) || job.updated > now - MINUTE) return
        job.updated = now
        this.ledger.save(job)
        try {
          if (job.state === "sealing") {
            await this.seal(job)
          } else {
            const object = await this.env.R2.head(stagedKey(job))
            if (object) await this.stage(job, object)
          }
        } catch {
          console.warn("[s3-upload] finalization recovery deferred", job.id)
        }
      })
    }
    for (const { id } of this.ledger.expired(now - DAY)) {
      if (this.active.has(id)) continue
      try {
        await this.exclusive(id, 0, async () => {
          const job = this.ledger.job(id)
          if (job) await this.abort(job)
        })
      } catch (error) {
        if (!(error instanceof S3Failure && error.code === "NoSuchUpload")) {
          console.warn("[s3-upload] incomplete upload cleanup deferred", id)
        }
      }
    }
    for (const { id } of this.ledger.dispatchable(now)) {
      if (this.active.has(id)) continue
      await this.exclusive(id, 0, async () => {
        const job = this.ledger.job(id)
        if (job && ["staged", "verified"].includes(job.state) && Math.max(job.next, job.sent) <= now) {
          await this.dispatch(job)
        }
      })
    }
    this.ledger.prune(now - RETENTION)
  }
}

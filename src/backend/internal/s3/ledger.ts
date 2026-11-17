import { fail, MAX_BUCKET_BYTES, MAX_FILE_SIZE } from "./protocol"
import type { Manifest, Part, UploadMetadata, UploadScope, UploadState, UploadTarget } from "./protocol"

export interface UploadJob extends UploadScope {
  id: string
  target: UploadTarget
  metadata: UploadMetadata
  state: UploadState
  created: number
  updated: number
  bytes: number
  size?: number
  etag?: string
  version?: string
  r2UploadId?: string
  manifest?: Manifest
  driveId?: string
  session?: string
  offset: number
  resolveOffset?: boolean
  attempts: number
  next: number
  sent: number
  error?: string
}

export interface LedgerStorage {
  sql: {
    exec(query: string, ...parameters: (number | string)[]): { toArray(): Record<string, unknown>[] }
  }
  transactionSync<T>(callback: () => T): T
  sync(): Promise<void>
  getAlarm(): Promise<number | null>
  setAlarm(time: number): Promise<void>
}

export type Audit = { bytes: number; finished: number; cursor?: string; scanning?: number; started?: number }

const HAS_DESTINATION_LOCK = "state NOT IN ('done','aborted','failed')"

export class UploadLedger {
  constructor(private readonly storage: LedgerStorage) {
    const { sql } = storage
    sql.exec("CREATE TABLE IF NOT EXISTS s3_jobs (id TEXT PRIMARY KEY, path TEXT NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, due INTEGER NOT NULL, data TEXT NOT NULL)")
    // Preserve index names so an earlier Worker can still open the database after a rollback.
    storage.transactionSync(() => {
      for (const column of ["path", "destination"]) {
        const name = "s3_active_" + column
        const existing = sql.exec("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?", name).toArray()[0]?.sql
        if (typeof existing === "string" && existing.endsWith(HAS_DESTINATION_LOCK)) continue
        sql.exec("DROP INDEX IF EXISTS " + name)
        sql.exec("CREATE UNIQUE INDEX " + name + " ON s3_jobs(" + column + ") WHERE " + HAS_DESTINATION_LOCK)
      }
    })
    sql.exec("CREATE INDEX IF NOT EXISTS s3_jobs_path ON s3_jobs(path, updated DESC)")
    sql.exec("CREATE INDEX IF NOT EXISTS s3_jobs_due ON s3_jobs(state, due)")
    sql.exec("CREATE TABLE IF NOT EXISTS s3_parts (id TEXT NOT NULL, number INTEGER NOT NULL, size INTEGER NOT NULL, pending INTEGER NOT NULL, etag TEXT NOT NULL, date INTEGER NOT NULL, PRIMARY KEY(id, number))")
    sql.exec("CREATE TABLE IF NOT EXISTS s3_audit (id INTEGER PRIMARY KEY, data TEXT NOT NULL)")
  }

  private rows<T>(query: string, ...parameters: (number | string)[]): T[] {
    return this.storage.sql.exec(query, ...parameters).toArray() as T[]
  }

  private jobs(query: string, ...parameters: (number | string)[]): UploadJob[] {
    return this.rows<{ data: string }>(query, ...parameters).map(({ data }) => JSON.parse(data))
  }

  job(id: string): UploadJob | undefined {
    return this.jobs("SELECT data FROM s3_jobs WHERE id = ?", id)[0]
  }

  activePath(path: string): UploadJob | undefined {
    return this.jobs("SELECT data FROM s3_jobs WHERE path = ? AND " + HAS_DESTINATION_LOCK, path)[0]
  }

  latest(scope: UploadScope) {
    return this.jobs("SELECT data FROM s3_jobs WHERE path=? AND json_extract(data, '$.owner')=? ORDER BY updated DESC LIMIT 1", scope.path, scope.owner)[0]
  }

  openUploads(owner: number, prefix: string, after: string, afterId: string, limit: number) {
    return this.jobs(
      "SELECT data FROM s3_jobs WHERE state IN ('open','sealing') AND json_extract(data,'$.owner')=? AND substr(path,1,length(?))=? AND (path>? OR (path=? AND id>?)) ORDER BY path,id LIMIT ?",
      owner, prefix, prefix, after, after, afterId, limit,
    ).map(({ path, id, created }) => ({ path, id, created }))
  }

  private destination(job: UploadJob) {
    return JSON.stringify([job.target.parentId, job.target.name])
  }

  insert(job: UploadJob, externalBytes?: number) {
    this.storage.transactionSync(() => {
      const active = this.rows("SELECT 1 FROM s3_jobs WHERE destination=? AND id<>? AND " + HAS_DESTINATION_LOCK, this.destination(job), job.id)
      const atPath = this.activePath(job.path)
      if (active.length || (atPath && atPath.id !== job.id)) fail("OperationAborted", "An upload already owns this destination", 409)
      if (externalBytes !== undefined) this.requireCapacity(job.bytes, externalBytes)
      this.save(job)
    })
  }

  save(job: UploadJob) {
    this.rows(
      "INSERT INTO s3_jobs VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,bytes=excluded.bytes,updated=excluded.updated,due=excluded.due,data=excluded.data",
      job.id, job.path, this.destination(job), job.state, job.bytes, job.created, job.updated, Math.max(job.next, job.sent), JSON.stringify(job),
    )
  }

  audit(): Audit {
    const row = this.rows<{ data: string }>("SELECT data FROM s3_audit WHERE id = 1")[0]
    return row ? JSON.parse(row.data) : { bytes: 0, finished: 0 }
  }

  saveAudit(audit: Audit) {
    this.rows("INSERT OR REPLACE INTO s3_audit VALUES (1,?)", JSON.stringify(audit))
  }

  sync() {
    return this.storage.sync()
  }

  reserved() {
    return this.rows<{ bytes: number }>("SELECT COALESCE(SUM(bytes),0) AS bytes FROM s3_jobs")[0].bytes
  }

  private requireCapacity(bytes: number, externalBytes: number) {
    if (this.reserved() + externalBytes + bytes > MAX_BUCKET_BYTES) {
      fail("ServiceUnavailable", "R2 staging quota exceeded. Retry after transfers finish.", 503)
    }
  }

  reservePart(id: string, number: number, size: number, externalBytes: number) {
    return this.storage.transactionSync(() => {
      const job = this.job(id)!
      const old = this.rows<{ size: number; pending: number }>(
        "SELECT size,pending FROM s3_parts WHERE id = ? AND number = ?", id, number,
      )[0]
      const pending = Math.max(size, old?.pending ?? 0)
      const logicalBytes = this.rows<{ bytes: number }>(
        "SELECT COALESCE(SUM(MAX(size,pending)),0) AS bytes FROM s3_parts WHERE id = ? AND number != ?", id, number,
      )[0].bytes + Math.max(old?.size ?? 0, pending)
      if (logicalBytes > MAX_FILE_SIZE) fail("EntityTooLarge", "Object exceeds 5000000000 bytes")
      const extra = pending - (old?.pending ?? 0)
      this.requireCapacity(extra, externalBytes)
      this.rows(
        "INSERT INTO s3_parts VALUES (?,?,0,?,'',0) ON CONFLICT(id,number) DO UPDATE SET pending=excluded.pending",
        id, number, pending,
      )
      job.bytes += extra
      job.updated = Date.now()
      this.save(job)
      return old?.pending ?? 0
    })
  }

  releaseFailedPart(id: string, number: number, previous: number) {
    this.storage.transactionSync(() => {
      const job = this.job(id)!
      const entry = this.rows<{ pending: number; size: number }>(
        "SELECT pending,size FROM s3_parts WHERE id=? AND number=?", id, number,
      )[0]
      job.bytes -= entry.pending - previous
      if (previous || entry.size) {
        this.rows("UPDATE s3_parts SET pending=? WHERE id=? AND number=?", previous, id, number)
      } else {
        this.rows("DELETE FROM s3_parts WHERE id=? AND number=?", id, number)
      }
      this.save(job)
    })
  }

  commitPart(id: string, part: Part) {
    this.storage.transactionSync(() => {
      const job = this.job(id)!
      const row = this.rows<{ size: number; pending: number }>(
        "SELECT size,pending FROM s3_parts WHERE id = ? AND number = ?", id, part.partNumber,
      )[0]
      job.bytes += part.size - row.size - row.pending
      job.updated = part.date
      this.rows("UPDATE s3_parts SET size=?,pending=0,etag=?,date=? WHERE id=? AND number=?",
        part.size, part.etag, part.date, id, part.partNumber)
      this.save(job)
    })
  }

  parts(id: string): (Part & { pending: number })[] {
    return this.rows("SELECT number AS partNumber,etag,size,date,pending FROM s3_parts WHERE id=? ORDER BY number", id)
  }

  closeParts(job: UploadJob) {
    this.storage.transactionSync(() => {
      this.rows("DELETE FROM s3_parts WHERE id=?", job.id)
      this.save(job)
    })
  }

  dispatchable(now: number) {
    return this.jobs("SELECT data FROM s3_jobs WHERE state IN ('staged','verified') AND due<=? ORDER BY due LIMIT 20", now)
  }

  unsettled(now: number, cutoff: number) {
    return this.jobs("SELECT data FROM s3_jobs WHERE state IN ('putting','sealing') AND updated<=? AND created>? ORDER BY updated LIMIT 10", now, cutoff)
  }

  expired(cutoff: number) {
    return this.jobs("SELECT data FROM s3_jobs WHERE state IN ('creating','putting','open','sealing','aborting') AND created<=? ORDER BY created LIMIT 20", cutoff)
  }

  failedExpired(cutoff: number) {
    // Use the time the job last entered/updated its failed state, not upload creation.
    return this.jobs("SELECT data FROM s3_jobs WHERE state='failed' AND updated<=? ORDER BY updated LIMIT 20", cutoff)
  }

  hasWork() {
    return !!this.rows("SELECT 1 FROM s3_jobs WHERE " + HAS_DESTINATION_LOCK + " LIMIT 1").length
  }

  prune(cutoff: number) {
    this.rows("DELETE FROM s3_jobs WHERE state IN ('done','aborted') AND updated<=?", cutoff)
  }
}

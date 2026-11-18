export const MiB = 1024 * 1024
// Inbound Cloudflare requests are capped at 100 MB on common plans. 75 MiB
// (78,643,200 bytes) leaves headroom while reducing multipart overhead.
export const S3_CHUNK_SIZE = 75 * MiB
export const MIN_PART_SIZE = 5 * MiB
export const MAX_FILE_SIZE = 5_000_000_000
export const MAX_BUCKET_BYTES = 9_500_000_000
// The R2 publisher cannot participate in DO transactions. Its entire namespace
// is capped at this amount, which is reserved before any external writes.
export const CLI_RELEASE_PREFIX = "cli-releases/"
export const CLI_RELEASE_BUDGET = 256 * MiB
export const STAGING_PREFIX = "__openlist_s3_staging/v1/"
export const JOB_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
export const XMLNS = ' xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'

export class S3Failure extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
  }
}

export function fail(code: string, message: string, status?: number): never {
  throw new S3Failure(code, message, status)
}

export function checkedSize(value: string | null, max: number): number {
  if (value === null) fail("MissingContentLength", "Content-Length is required", 411)
  if (!/^\d+$/.test(value)) fail("InvalidArgument", "Invalid Content-Length")
  const bytes = Number(value)
  if (!Number.isSafeInteger(bytes) || bytes > max) {
    fail("EntityTooLarge", "Upload exceeds the " + max + " byte limit")
  }
  return bytes
}

export function quoteETag(value: string): string {
  return '"' + value.replace(/^"|"$/g, "") + '"'
}

export function hexMD5(value: string | null): string | undefined {
  if (!value) return undefined
  if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) fail("InvalidDigest", "Invalid MD5 header")
  return Array.from(atob(value), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
}

export type UploadMetadata = {
  contentType: string
  mtime?: string
  md5?: string
}
export type UploadTarget = {
  path: string
  storageId: number
  rootId: string
  parentId: string
  name: string
}
export type UploadScope = { owner: number; path: string }
export type Part = { partNumber: number; etag: string; size: number; date: number }
export type Manifest = Pick<Part, "partNumber" | "etag">[]
export type UploadState =
  | "creating" | "putting" | "open" | "sealing" | "aborting" | "aborted"
  | "staged" | "verified" | "done" | "failed"

export type UploadStatus = {
  id: string
  state: UploadState
  bytes: number
  size?: number
  etag?: string
  offset: number
  updated: number
  driveId?: string
  metadata: UploadMetadata
  error?: string
}

export interface QueueJob { version: 1; id: string }

// Structural types keep Cloudflare-only APIs out of the other runtime entry points.
export interface StagedObject {
  key: string
  size: number
  etag: string
  version: string
  customMetadata?: Record<string, string>
}
interface R2Multipart {
  uploadId: string
  uploadPart(part: number, body: ReadableStream<Uint8Array>): Promise<{ etag: string }>
  complete(parts: Manifest): Promise<StagedObject>
  abort(): Promise<void>
}
export interface UploadEnv {
  R2: {
    createMultipartUpload(key: string, options: object): Promise<R2Multipart>
    resumeMultipartUpload(key: string, uploadId: string): R2Multipart
    put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, options: object): Promise<StagedObject | null>
    head(key: string): Promise<StagedObject | null>
    get(key: string, options: object): Promise<(StagedObject & { arrayBuffer(): Promise<ArrayBuffer> }) | null>
    list(options: object): Promise<{ objects: StagedObject[]; truncated: boolean; cursor?: string }>
    delete(key: string): Promise<void>
  }
  UPLOAD_QUEUE: { send(message: QueueJob): Promise<void> }
  S3_UPLOADS: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
  S3_UPLOAD_MODE?: string
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  /** Optional second SigV4 credential pair; maps to the same S3_USER_ID. */
  S3_S5CMD_ACCESS_KEY_ID?: string
  S3_S5CMD_SECRET_ACCESS_KEY?: string
  S3_USER_ID?: string
  S3_EXTERNAL_MULTIPART_BYTES?: string
  S3_FAILED_RETENTION_HOURS?: string
}

export function uploadsEnabled(env?: Partial<UploadEnv>): env is UploadEnv {
  return (env?.S3_UPLOAD_MODE === "enabled" || env?.S3_UPLOAD_MODE === "drain") && !!env.S3_UPLOADS && !!env.R2 && !!env.UPLOAD_QUEUE
}

export async function uploadCall<T>(
  env: UploadEnv,
  action: string,
  payload: object,
  stream?: ReadableStream<Uint8Array> | null,
): Promise<T> {
  const stub = env.S3_UPLOADS.get(env.S3_UPLOADS.idFromName("r2-data-v1"))
  const request = new Request("https://openlist-upload.internal/" + action, {
    method: "POST",
    ...(stream
      ? { body: stream, headers: { "x-upload-parameters": encodeURIComponent(JSON.stringify(payload)) }, duplex: "half" }
      : { body: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
  })
  const response = await stub.fetch(request)
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { code: string; message: string } | null
    if (!error) fail("ServiceUnavailable", "Upload coordinator is temporarily unavailable", 503)
    fail(error.code, error.message, response.status)
  }
  return response.json() as Promise<T>
}

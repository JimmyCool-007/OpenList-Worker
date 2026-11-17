import {
  driveChildren,
  driveFile,
  driveProgress,
  generateDriveId,
  startDriveUpload,
  DriveUploadError,
} from "../../drivers/google_drive/resumable"
import type { GoogleDriveClient } from "../../drivers/google_drive/util"
import { MiB, STAGING_PREFIX } from "./protocol"
import type { StagedObject, UploadEnv } from "./protocol"
import type { UploadJob, UploadLedger } from "./ledger"
import type { loadUploadTarget } from "./target"

export type ResolveUploadClient = typeof loadUploadTarget

const DRIVE_CHUNK = 16 * MiB

export function stagedKey(job: UploadJob) {
  return STAGING_PREFIX + job.id
}

export function isJobObject(job: UploadJob, object: StagedObject) {
  return object.customMetadata?.openlistUpload === job.id &&
    (job.size === undefined || object.size === job.size) &&
    (job.version === undefined || object.version === job.version)
}

export async function verifyDriveFile(client: GoogleDriveClient, job: UploadJob) {
  const file = await driveFile(client, job.driveId!)
  if (!file) return false
  if (file.appProperties?.openlistUpload !== job.id || file.trashed ||
      file.name !== job.target.name || !file.parents?.includes(job.target.parentId) ||
      file.size !== String(job.size) ||
      (job.metadata.md5 && file.md5Checksum?.toLowerCase() !== job.metadata.md5)) {
    throw new DriveUploadError("verify file identity, size and checksum", 409)
  }
  const names = await driveChildren(client, job.target.parentId, job.target.name)
  if (names.length !== 1 || names[0].id !== file.id) {
    throw new DriveUploadError("verify unique destination", 409)
  }
  return true
}

async function recordVerified(env: UploadEnv, ledger: UploadLedger, job: UploadJob, resolve: ResolveUploadClient) {
  const client = await resolve(env, job, job.target, true)
  if (!await verifyDriveFile(client, job)) throw new DriveUploadError("confirm completed file", 502)
  job.state = "verified"
  job.offset = job.size!
  job.session = undefined
  job.resolveOffset = undefined
  ledger.save(job)
}

export async function transferChunk(env: UploadEnv, ledger: UploadLedger, job: UploadJob, resolve: ResolveUploadClient): Promise<void> {
  if (job.state === "verified") {
    const client = await resolve(env, job, job.target, true)
    if (!await verifyDriveFile(client, job)) throw new DriveUploadError("confirm file before cleanup", 409)
    const key = stagedKey(job)
    const object = await env.R2.head(key)
    if (object) {
      if (!isJobObject(job, object)) throw new Error("R2 staging object no longer matches upload")
      await env.R2.delete(key)
    }
    job.state = "done"
    job.bytes = 0
    return
  }

  const client = await resolve(env, job, job.target, !job.session)
  if (!job.session) {
    if (!job.driveId) {
      job.driveId = await generateDriveId(client)
      ledger.save(job)
      await ledger.sync()
    } else if (await verifyDriveFile(client, job)) {
      await recordVerified(env, ledger, job, resolve)
      return
    }
    if ((await driveChildren(client, job.target.parentId, job.target.name)).length) {
      throw new DriveUploadError("create file without overwriting", 409)
    }
    const metadata = {
      id: job.driveId,
      name: job.target.name,
      parents: [job.target.parentId],
      modifiedTime: job.metadata.mtime,
      appProperties: { openlistUpload: job.id },
    }
    job.session = await startDriveUpload(client, metadata, job.size!, job.metadata.contentType) ?? undefined
    job.offset = 0
    job.resolveOffset = false
    ledger.save(job)
    if (!job.session) {
      await recordVerified(env, ledger, job, resolve)
      return
    }
  }

  if (job.resolveOffset) {
    const result = await driveProgress(client, job.session, job.size!)
    if (result.state === "complete") {
      await recordVerified(env, ledger, job, resolve)
      return
    }
    if (result.state === "expired") {
      job.session = undefined
      job.offset = 0
      job.resolveOffset = false
      return
    }
    if (result.state === "partial") job.offset = result.offset
  }

  const offset = job.offset
  const length = Math.min(DRIVE_CHUNK, job.size! - offset)
  const source = await env.R2.get(stagedKey(job), { range: { offset, length } })
  if (!source || !isJobObject(job, source)) {
    throw new Error("R2 staging object no longer matches upload")
  }
  const data = await source.arrayBuffer()
  if (data.byteLength !== length) throw new Error("Unexpected R2 range length")

  // This intent is durable before any bytes go to Drive. If the response is
  // lost, the next invocation uses Google's offset, including after a restart.
  job.resolveOffset = true
  ledger.save(job)
  await ledger.sync()
  const result = await driveProgress(client, job.session, job.size!, {
    offset, data, contentType: job.metadata.contentType,
  })
  if (result.state === "complete") {
    await recordVerified(env, ledger, job, resolve)
  } else if (result.state === "expired") {
    job.session = undefined
    job.offset = 0
    job.resolveOffset = false
  } else if (result.state === "partial") {
    if (result.offset <= offset || result.offset > offset + length) {
      throw new DriveUploadError("confirm upload made progress", 502)
    }
    job.offset = result.offset
    job.resolveOffset = false
  }
}

import { GoogleDrive } from "../drivers/google_drive/driver"
import { driveChildren, driveFile, driveParent, generateDriveId, type DriveUploadFile } from "../drivers/google_drive/resumable"
import { GOOGLE_DRIVE_FOLDER_MIME as FOLDER } from "../drivers/google_drive/types"
import type { GoogleDriveClient } from "../drivers/google_drive/util"
import { resolvePath } from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import { fail } from "../internal/s3/protocol"
import { canAccess, getNearestMeta, isHidden, canWrite as canWriteMeta } from "../pkg/meta"
import { canSeeHides, canWrite, getActualPath, isWithinUserRoot } from "../pkg/permission"
import { cliState, digest, type CliEnv, type CliUser } from "./cli-auth"

const DRIVE = "https://www.googleapis.com/drive/v3"

export function cliRoot(user: CliUser) {
  const root = getActualPath(user, "/")
  if (isWithinUserRoot(user, "/drive")) return "/drive"
  if (root.startsWith("/drive/")) return root
  fail("AccessDenied", "Your OpenList account has no access to /drive", 403)
}

function safeName(name: string) {
  return !!name && name !== "." && name !== ".." && !name.includes("\\") && !/[\/\x00-\x1f\x7f]|\.{3}|%[0-9a-f]{2}/i.test(name)
}

export function cliPath(user: CliUser, input: unknown) {
  if (typeof input !== "string" || input.length > 4096 ||
      (input !== "" && !input.split("/").every(safeName))) {
    fail("InvalidPath", "Invalid relative Drive path", 400)
  }
  const root = cliRoot(user)
  return input ? root + "/" + input : root
}

export function containsPath(path: string, root: string) {
  return path === root || path.startsWith(root + "/")
}

export async function mayRead(env: CliEnv, user: CliUser, path: string, root: string) {
  if (!containsPath(path, root)) return false
  const first = root.slice(1).split("/").length
  const segments = path.slice(1).split("/")
  for (let i = first; i <= segments.length; i++) {
    const part = "/" + segments.slice(0, i).join("/")
    if (!canAccess(user, await getNearestMeta(part, env), part)) return false
    if (i > first && !canSeeHides(user)) {
      const parent = "/" + segments.slice(0, i - 1).join("/")
      if (isHidden(await getNearestMeta(parent, env), parent, segments[i - 1])) return false
    }
  }
  return true
}

export async function authorizeCliPath(env: CliEnv, user: CliUser, path: string, write = false) {
  const root = cliRoot(user)
  if (!await mayRead(env, user, path, root)) fail("AccessDenied", "Drive path is not accessible", 403)
  if (write) {
    const parent = path.slice(0, path.lastIndexOf("/"))
    if (path === root || !canWrite(user) ||
        !canWriteMeta(user, await getNearestMeta(path, env), path) ||
        !canWriteMeta(user, await getNearestMeta(parent, env), parent)) {
      fail("AccessDenied", "Drive path is not writable", 403)
    }
  }
}

async function context(env: CliEnv, path: string) {
  const resolved = await resolvePath(path, env)
  if (!resolved.storage || resolved.cleanPath !== path || !resolved.physical) {
    fail("NotFound", "Google Drive mount was not found", 404)
  }
  const driver = await getDriver(resolved.storage.driver, resolved.storage)
  if (!(driver instanceof GoogleDrive)) fail("Unsupported", "This path requires a Google Drive mount", 422)
  return { client: driver.getUploadClient(), physical: resolved.physical }
}

function unique(items: DriveUploadFile[]) {
  if (!items.length) fail("NotFound", "Drive item was not found", 404)
  if (items.length !== 1) fail("Conflict", "Drive contains multiple items with this name", 409)
  return items[0]
}

async function findItem(client: GoogleDriveClient, physical: string) {
  const root = await driveFile(client, client.getRootFolderId())
  if (!root || root.trashed || root.mimeType !== FOLDER) fail("NotFound", "Google Drive root was not found", 404)
  let current = root
  for (const name of physical.split("/").filter(Boolean)) {
    if (current.mimeType !== FOLDER) fail("NotFound", "Drive folder was not found", 404)
    current = unique(await driveChildren(client, current.id, name))
  }
  return current
}

function info(file: DriveUploadFile) {
  return {
    name: file.name, isDir: file.mimeType === FOLDER,
    size: file.size === undefined ? null : Number(file.size), md5: file.md5Checksum,
    sha256: file.sha256Checksum, version: file.id + ":" + (file.version ?? ""),
  }
}

export async function cliStat(env: CliEnv, path: string) {
  const { client, physical } = await context(env, path)
  return info(await findItem(client, physical))
}

export async function cliList(env: CliEnv, user: CliUser, path: string, cursor: string) {
  const { client, physical } = await context(env, path)
  const directory = await findItem(client, physical)
  if (directory.mimeType !== FOLDER) fail("InvalidPath", "Expected a Drive folder", 400)
  const params = new URLSearchParams({
    q: "'" + directory.id.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "' in parents and trashed = false",
    fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,sha256Checksum,version)",
    pageSize: "100", orderBy: "name",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })
  if (cursor) params.set("pageToken", cursor)
  const response = await client.requestUpload(DRIVE + "/files?" + params)
  if (!response.ok) fail("DriveUnavailable", "Could not list the Drive folder", response.status === 400 ? 400 : 503)
  const data = await response.json() as { files?: DriveUploadFile[]; nextPageToken?: string }
  const root = cliRoot(user)
  const visible: ReturnType<typeof info>[] = []
  for (const file of data.files ?? []) {
    if (safeName(file.name) && await mayRead(env, user, path + "/" + file.name, root)) visible.push(info(file))
  }
  return { entries: visible, next: data.nextPageToken ?? "" }
}

export async function ensureCliFolder(env: CliEnv, path: string) {
  const { client, physical } = await context(env, path)
  if (physical === "/") fail("InvalidPath", "Cannot create a storage mount", 400)
  const { parentId, name } = await driveParent(client, physical)
  const existing = await driveChildren(client, parentId, name)
  if (existing.length) {
    if (unique(existing).mimeType !== FOLDER) fail("Conflict", "A file already has this folder name", 409)
    return
  }
  const key = await digest(JSON.stringify([parentId, name]))
  const saved = await cliState<string | null>(env, "folder-id", { key })
  const id = saved ?? await cliState<string>(env, "folder-id", { key, proposed: await generateDriveId(client) })
  const response = await client.requestUpload(DRIVE + "/files?supportsAllDrives=true", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, parents: [parentId], mimeType: FOLDER }),
  })
  await response.body?.cancel()
  if (!response.ok && response.status !== 409) fail("DriveUnavailable", "Could not create the Drive folder", 503)
  const actual = await driveFile(client, id)
  if (actual?.trashed) {
    await cliState(env, "forget-folder", { key, proposed: id })
    fail("Retry", "Drive folder was removed. Retry folder creation.", 503)
  }
  const matches = await driveChildren(client, parentId, name)
  if (matches.length === 0) fail("Retry", "Waiting for Drive to confirm the folder", 503)
  if (!actual || actual.mimeType !== FOLDER || unique(matches).id !== id ||
      !actual.parents?.includes(parentId) || actual.name !== name) {
    fail("Conflict", "Drive folder could not be confirmed uniquely", 409)
  }
}

export async function cliDownload(env: CliEnv, path: string, request: Request) {
  const { client, physical } = await context(env, path)
  const file = await findItem(client, physical)
  const entry = info(file)
  if (entry.isDir || entry.size === null || !Number.isSafeInteger(entry.size) ||
      file.mimeType.startsWith("application/vnd.google-apps.")) {
    fail("Unsupported", "Only regular Google Drive files can be downloaded", 422)
  }
  const expected = request.headers.get("x-ol-version")
  if (expected !== entry.version) fail("Changed", "Drive file changed. Restart the download.", 412)
  const range = request.headers.get("range")
  if (range && !/^bytes=\d+-$/.test(range)) fail("InvalidRange", "Unsupported byte range", 416)
  const headers = new Headers(range ? { range } : undefined)
  let url = client.getDownloadUrl(file.id)
  let res = await client.requestUpload(url, { headers, signal: request.signal })
  for (let i = 0; res.status >= 300 && res.status < 400 && i < 4; i++) {
    const location = res.headers.get("location")
    await res.body?.cancel()
    if (!location) fail("DriveUnavailable", "Drive download redirect is missing a location", 502)
    const next = new URL(location, url)
    const host = next.hostname.toLowerCase()
    if (next.protocol !== "https:" || next.port || next.username || next.password ||
        (host !== "www.googleapis.com" && host !== "drive.google.com" && !host.endsWith(".googleusercontent.com"))) {
      fail("DriveUnavailable", "Drive returned an unsupported download redirect", 502)
    }
    url = next.href
    res = await fetch(url, { headers, redirect: "manual", signal: request.signal })
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel()
    fail("DriveUnavailable", "Drive could not serve this file or range", res.status === 416 ? 416 : 502)
  }
  const output = new Headers({ "content-type": "application/octet-stream", "cache-control": "private, no-store" })
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = res.headers.get(name)
    if (value) output.set(name, value)
  }
  return new Response(res.body, { status: res.status, headers: output })
}

import { GOOGLE_DRIVE_FOLDER_MIME } from "./types"
import type { GoogleDriveClient } from "./util"

const DRIVE = "https://www.googleapis.com/drive/v3"
const UPLOAD = "https://www.googleapis.com/upload/drive/v3"
const FIELDS = "id,name,mimeType,size,parents,trashed,md5Checksum,appProperties,capabilities(canAddChildren)"

export class DriveUploadError extends Error {
  constructor(public operation: string, public status: number) {
    super("Google Drive " + operation + " (" + status + ")")
  }
}

export type DriveUploadFile = {
  id: string
  name: string
  mimeType: string
  size?: string
  parents?: string[]
  trashed?: boolean
  md5Checksum?: string
  appProperties?: Record<string, string>
  capabilities?: { canAddChildren?: boolean }
}

function query(params: Record<string, string>) {
  return "?" + new URLSearchParams({ supportsAllDrives: "true", ...params }).toString()
}

function driveLiteral(value: string) {
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"
}

export async function driveFile(client: GoogleDriveClient, id: string): Promise<DriveUploadFile | null> {
  const response = await client.requestUpload(DRIVE + "/files/" + encodeURIComponent(id) + query({ fields: FIELDS }))
  if (response.status === 404) return null
  if (!response.ok) throw new DriveUploadError("read metadata", response.status)
  return response.json()
}

export async function driveChildren(client: GoogleDriveClient, parent: string, name: string): Promise<DriveUploadFile[]> {
  const response = await client.requestUpload(DRIVE + "/files" + query({
    q: driveLiteral(parent) + " in parents and trashed = false and name = " + driveLiteral(name),
    includeItemsFromAllDrives: "true",
    fields: "nextPageToken,files(" + FIELDS + ")",
    pageSize: "2",
  }))
  if (!response.ok) throw new DriveUploadError("find destination", response.status)
  const result = await response.json() as { files?: DriveUploadFile[]; nextPageToken?: string }
  if (result.nextPageToken) throw new DriveUploadError("ambiguous destination", 409)
  return result.files ?? []
}

export async function driveParent(client: GoogleDriveClient, physicalPath: string) {
  const segments = physicalPath.split("/").filter(Boolean)
  const name = segments.pop()!
  const root = await driveFile(client, client.getRootFolderId())
  if (!root || root.trashed || root.mimeType !== GOOGLE_DRIVE_FOLDER_MIME) {
    throw new DriveUploadError("resolve mount root", 404)
  }
  let parent = root
  for (const segment of segments) {
    const folders = await driveChildren(client, parent.id, segment)
    if (folders.length !== 1 || folders[0].mimeType !== GOOGLE_DRIVE_FOLDER_MIME) {
      throw new DriveUploadError("resolve destination folder", folders.length ? 409 : 404)
    }
    parent = folders[0]
  }
  if (parent.capabilities?.canAddChildren === false) throw new DriveUploadError("write destination", 403)
  return { rootId: root.id, parentId: parent.id, name }
}

export async function generateDriveId(client: GoogleDriveClient): Promise<string> {
  const response = await client.requestUpload(DRIVE + "/files/generateIds?count=1&space=drive")
  if (!response.ok) throw new DriveUploadError("allocate file ID", response.status)
  const result = await response.json() as { ids?: string[] }
  if (!result.ids?.[0]) throw new DriveUploadError("allocate file ID", 502)
  return result.ids[0]
}

function checkSession(url: string): string {
  const parsed = new URL(url)
  if (parsed.origin !== "https://www.googleapis.com" || parsed.username || parsed.password ||
      parsed.pathname !== "/upload/drive/v3/files" || !parsed.searchParams.has("upload_id")) {
    throw new DriveUploadError("validate upload session", 502)
  }
  return parsed.href
}

export async function startDriveUpload(
  client: GoogleDriveClient,
  metadata: object,
  size: number,
  contentType: string,
): Promise<string | null> {
  if (size === 0) {
    const boundary = "openlist-" + crypto.randomUUID()
    const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) + "\r\n--" + boundary + "\r\nContent-Type: " + contentType +
      "\r\n\r\n\r\n--" + boundary + "--\r\n"
    const response = await client.requestUpload(UPLOAD + "/files" + query({ uploadType: "multipart", fields: "id" }), {
      method: "POST",
      headers: { "Content-Type": "multipart/related; boundary=" + boundary },
      body,
    })
    if (!response.ok && response.status !== 409) throw new DriveUploadError("create empty file", response.status)
    await response.body?.cancel()
    return null
  }
  const response = await client.requestUpload(UPLOAD + "/files" + query({ uploadType: "resumable", fields: "id" }), {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": contentType,
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify(metadata),
  })
  const location = response.headers.get("location")
  if (response.status === 409) return null
  if (!response.ok || !location) throw new DriveUploadError("start upload session", response.ok ? 502 : response.status)
  await response.body?.cancel()
  return checkSession(location)
}

export async function driveProgress(
  client: GoogleDriveClient,
  session: string,
  total: number,
  range?: { offset: number; data: ArrayBuffer; contentType: string },
): Promise<{ state: "expired" | "complete" } | { state: "partial"; offset: number }> {
  const contentRange = range
    ? "bytes " + range.offset + "-" + (range.offset + range.data.byteLength - 1) + "/" + total
    : "bytes */" + total
  const response = await client.requestUpload(checkSession(session), {
    method: "PUT",
    headers: {
      "Content-Range": contentRange,
      "Content-Length": String(range?.data.byteLength ?? 0),
      ...(range ? { "Content-Type": range.contentType } : {}),
    },
    body: range?.data ?? new ArrayBuffer(0),
  })
  const committed = response.headers.get("range")
  await response.body?.cancel()
  if (response.status === 404 || response.status === 410) return { state: "expired" }
  if (response.ok) return { state: "complete" }
  if (response.status !== 308) throw new DriveUploadError("upload bytes", response.status)
  const end = committed ? /^bytes=0-(\d+)$/.exec(committed)?.[1] : undefined
  const offset = end ? Number(end) + 1 : 0
  if ((committed && !end) || !Number.isSafeInteger(offset) || offset >= total) {
    throw new DriveUploadError("parse resume position", 502)
  }
  return { state: "partial", offset }
}

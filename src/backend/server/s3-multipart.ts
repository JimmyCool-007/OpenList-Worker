import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom"
import { sha256Hex } from "../drivers/s3/sigv4"
import {
  checkedSize, fail, hexMD5, JOB_ID, MAX_FILE_SIZE, quoteETag, S3_CHUNK_SIZE,
  uploadCall, uploadsEnabled, XMLNS,
} from "../internal/s3/protocol"
import type { Manifest, Part, UploadEnv, UploadMetadata, UploadScope, UploadStatus } from "../internal/s3/protocol"
import { payloadSHA256 } from "../internal/s3/sigv4"
import { authorizeUpload, resolveUploadTarget } from "../internal/s3/target"

export function xmlEscape(text: string) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function s3Xml(name: string, content: string, headers: Record<string, string> = {}) {
  return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<' + name + XMLNS + ">" + content + "</" + name + ">", {
    headers: { "Content-Type": "application/xml", "x-amz-request-id": crypto.randomUUID(), ...headers },
  })
}

export function xmlTag(name: string, value: string | number | boolean) {
  return "<" + name + ">" + xmlEscape(String(value)) + "</" + name + ">"
}

export function decimal(value: string | null, fallback: number, max: number) {
  if (value === null) return fallback
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    fail("InvalidArgument", "Invalid S3 numeric parameter")
  }
  return Number(value)
}

const MAX_MANIFEST = 256 * 1024

async function readManifest(request: Request): Promise<Manifest> {
  if (!request.body) fail("MalformedXML", "Expected CompleteMultipartUpload XML")
  const reader = request.body.getReader()
  const data = new Uint8Array(MAX_MANIFEST)
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > MAX_MANIFEST) {
        await reader.cancel()
        fail("MalformedXML", "CompleteMultipartUpload XML is too large")
      }
      data.set(value, size)
      size += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const sha = payloadSHA256(request)
  if (sha && await sha256Hex(data.subarray(0, size)) !== sha) {
    fail("BadDigest", "Complete request does not match its checksum")
  }
  let xml
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size))
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error("Unsupported XML")
    xml = new DOMParser({ onError: onErrorStopParsing }).parseFromString(content, "application/xml")
  } catch {
    fail("MalformedXML", "Invalid CompleteMultipartUpload XML")
  }
  const root = xml.documentElement
  if (root?.localName !== "CompleteMultipartUpload") fail("MalformedXML", "Missing CompleteMultipartUpload")
  const elements = root.getElementsByTagNameNS(root.namespaceURI, "Part")
  if (!elements.length || elements.length > 10000) fail("MalformedXML", "Invalid number of parts")
  const manifest: Manifest = []
  for (let i = 0; i < elements.length; i++) {
    const element = elements.item(i)!
    const number = element.getElementsByTagNameNS(root.namespaceURI, "PartNumber")
    const tags = element.getElementsByTagNameNS(root.namespaceURI, "ETag")
    const etag = tags.item(0)?.textContent?.trim().replace(/^"|"$/g, "")
    if (number.length !== 1 || tags.length !== 1 || !etag || etag.length > 128) {
      fail("MalformedXML", "Each part requires one PartNumber and ETag")
    }
    const partNumber = decimal(number.item(0)?.textContent?.trim() ?? "", 0, 10000)
    if (partNumber <= (manifest[i - 1]?.partNumber ?? 0)) {
      fail("InvalidPartOrder", "Parts must be in ascending order")
    }
    manifest.push({ partNumber, etag })
  }
  return manifest
}

function metadata(request: Request): UploadMetadata {
  const headers = request.headers
  const contentType = headers.get("content-type") || "application/octet-stream"
  if (!/^[\x20-\x7e]{1,255}$/.test(contentType) || /^application\/vnd\.google-apps/i.test(contentType)) {
    fail("InvalidArgument", "Unsupported content type")
  }
  const mtime = headers.get("x-amz-meta-mtime")
  const millis = mtime && /^-?\d+(\.\d+)?$/.test(mtime) ? Number(mtime) * 1000 : NaN
  const date = new Date(millis)
  return {
    contentType,
    mtime: Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999
      ? date.toISOString() : undefined,
    md5: hexMD5(headers.get("x-amz-meta-md5chksum")),
  }
}

function payloadInfo(request: Request) {
  if (request.headers.get("content-encoding")?.includes("aws-chunked") || request.headers.has("x-amz-trailer")) {
    fail("NotImplemented", "Set use_data_integrity_protections=false to send a regular S3 request body", 501)
  }
  const size = checkedSize(request.headers.get("content-length") ?? (request.body ? null : "0"), S3_CHUNK_SIZE)
  const md5 = hexMD5(request.headers.get("content-md5"))
  const sha256 = payloadSHA256(request)
  if (size && !md5 && !sha256) fail("InvalidDigest", "Supply Content-MD5 or x-amz-content-sha256")
  return { size, checksums: { md5, sha256 } }
}

export function uploadOperation(request: Request, signed: boolean) {
  const q = new URL(request.url).searchParams
  if (q.has("uploadId") || q.has("uploads") || q.has("partNumber") ||
      q.has("openlist-status") || q.has("openlist-retry")) return true
  return signed && request.method === "PUT"
}

export async function handleUpload(
  request: Request,
  env: Partial<UploadEnv>,
  scope: UploadScope,
  bucket: string,
  key: string,
) {
  if (!uploadsEnabled(env)) fail("ServiceUnavailable", "S3 staging bindings or mode are unavailable", 503)
  await authorizeUpload(env, scope)
  const url = new URL(request.url)
  const q = url.searchParams
  const id = q.get("uploadId")
  if (id !== null && !JOB_ID.test(id)) fail("NoSuchUpload", "Upload was not found", 404)
  const args = { ...scope, id }
  const method = request.method
  const location = xmlTag("Bucket", bucket) + xmlTag("Key", key)

  if (method === "GET" && q.has("openlist-status")) {
    return Response.json(await uploadCall<UploadStatus>(env, "status", args), {
      headers: { "Cache-Control": "no-store" },
    })
  }
  if (method === "POST" && id && q.has("openlist-retry")) {
    return Response.json(await uploadCall<UploadStatus>(env, "retry", args), {
      headers: { "Cache-Control": "no-store" },
    })
  }
  if ((method === "POST" && q.has("uploads") && !id) || (method === "PUT" && !id && !q.has("partNumber"))) {
    if (env.S3_UPLOAD_MODE !== "enabled") fail("ServiceUnavailable", "New staging uploads are paused", 503)
    // The staged S3 API never overwrites Drive files or follows conditional COPY semantics.
    if (request.headers.has("x-amz-copy-source") || request.headers.has("if-match")) {
      fail("NotImplemented", "S3 COPY and overwrite are unavailable for staged uploads", 501)
    }
    const meta = metadata(request)
    const single = method === "PUT"
    const info = single ? payloadInfo(request) : undefined
    const target = await resolveUploadTarget(env, scope)
    const job = await uploadCall<UploadStatus>(env, single ? "put" : "create", {
      ...scope, target, metadata: meta, ...info,
    }, single ? request.body : undefined)
    if (single) return new Response(null, {
      headers: { ETag: quoteETag(job.etag!), "x-openlist-upload-id": job.id },
    })
    return s3Xml("InitiateMultipartUploadResult", location + xmlTag("UploadId", job.id))
  }
  if (!id) fail("InvalidArgument", "UploadId is required")

  if (method === "PUT") {
    const number = decimal(q.get("partNumber"), 0, 10000)
    if (!number) fail("InvalidArgument", "PartNumber must be in [1, 10000]")
    if (request.headers.has("x-amz-copy-source")) fail("NotImplemented", "UploadPartCopy is unsupported", 501)
    const info = payloadInfo(request)
    if (!info.size) fail("EntityTooSmall", "Empty parts are unsupported. Use a single PUT for an empty file.")
    const part = await uploadCall<Part>(env, "part", { ...args, ...info, number }, request.body)
    return new Response(null, { headers: { ETag: quoteETag(part.etag) } })
  }

  if (method === "POST") {
    const expected = request.headers.get("x-amz-mp-object-size")
    const expectedSize = expected !== null ? checkedSize(expected, MAX_FILE_SIZE) : undefined
    const manifest = await readManifest(request)
    const job = await uploadCall<UploadStatus>(env, "complete", { ...args, manifest, expectedSize })
    return s3Xml("CompleteMultipartUploadResult",
      xmlTag("Location", url.origin + url.pathname) + location + xmlTag("ETag", quoteETag(job.etag!)),
      { "x-openlist-upload-id": job.id },
    )
  }

  if (method === "DELETE") {
    await uploadCall(env, "abort", args)
    return new Response(null, { status: 204 })
  }

  if (method === "GET") {
    const marker = decimal(q.get("part-number-marker"), 0, 10000)
    const limit = decimal(q.get("max-parts"), 1000, 1000)
    const all = (await uploadCall<Part[]>(env, "parts", args)).filter((part) => part.partNumber > marker)
    const parts = all.slice(0, limit)
    const next = parts.at(-1)?.partNumber ?? marker
    return s3Xml("ListPartsResult", location + xmlTag("UploadId", id) +
      xmlTag("PartNumberMarker", marker) + xmlTag("NextPartNumberMarker", next) +
      xmlTag("MaxParts", limit) + xmlTag("IsTruncated", limit > 0 && all.length > parts.length) +
      parts.map((part) => "<Part>" + xmlTag("PartNumber", part.partNumber) +
        xmlTag("LastModified", new Date(part.date).toISOString()) + xmlTag("ETag", quoteETag(part.etag)) +
        xmlTag("Size", part.size) + "</Part>").join(""))
  }
  fail("NotImplemented", "Unsupported multipart operation", 501)
}

export function stagedHead(job: UploadStatus) {
  const date = job.metadata.mtime ?? new Date(job.updated).toISOString()
  const headers = new Headers({
    "Content-Type": job.metadata.contentType,
    "Content-Length": String(job.size ?? 0),
    "Last-Modified": new Date(date).toUTCString(),
    ETag: quoteETag(job.etag!),
    "Cache-Control": "no-store",
    "x-openlist-upload-id": job.id,
    "x-openlist-upload-state": job.state,
    "x-amz-meta-mtime": String(Date.parse(date) / 1000),
  })
  if (job.metadata.md5) {
    headers.set("x-amz-meta-md5chksum", btoa(String.fromCharCode(...job.metadata.md5.match(/../g)!.map((byte) => parseInt(byte, 16)))))
  }
  return new Response(null, { headers })
}

export async function listS3Uploads(request: Request, env: Partial<UploadEnv>, scope: UploadScope, bucket: string) {
  if (!uploadsEnabled(env)) fail("ServiceUnavailable", "S3 staging bindings or mode are unavailable", 503)
  const search = new URL(request.url).searchParams
  const prefix = search.get("prefix") ?? ""
  const marker = search.get("key-marker") ?? ""
  const id = search.get("upload-id-marker") ?? ""
  const limit = decimal(search.get("max-uploads"), 1000, 1000)
  const encoding = search.get("encoding-type")
  if (search.get("delimiter") || (encoding && encoding !== "url") ||
      [prefix, marker].some((path) => /\\|[\x00-\x1f]|\.{3}|%[0-9a-f]{2}/i.test(path) ||
        path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) ||
      (id && !JOB_ID.test(id))) {
    fail("InvalidArgument", "Invalid multipart listing option")
  }
  const path = scope.path + "/"
  const jobs = limit ? await uploadCall<{ path: string; id: string; created: number }[]>(env, "uploads", {
    owner: scope.owner, path: path + prefix, after: marker ? path + marker : "", afterId: id || "~", limit: limit + 1,
  }) : []
  const page = jobs.slice(0, limit)
  const last = page.at(-1)
  const keyTag = (name: string, key: string) => xmlTag(name, encoding ? encodeURIComponent(key) : key)
  const truncated = jobs.length > page.length
  return s3Xml("ListMultipartUploadsResult",
    xmlTag("Bucket", bucket) + keyTag("Prefix", prefix) + keyTag("KeyMarker", marker) +
    xmlTag("UploadIdMarker", id) + xmlTag("MaxUploads", limit) +
    (encoding ? xmlTag("EncodingType", encoding) : "") + xmlTag("IsTruncated", truncated) +
    (truncated && last ? keyTag("NextKeyMarker", last.path.slice(path.length)) +
      xmlTag("NextUploadIdMarker", last.id) : "") +
    page.map(job => "<Upload>" + keyTag("Key", job.path.slice(path.length)) +
      xmlTag("UploadId", job.id) + xmlTag("StorageClass", "STANDARD") +
      xmlTag("Initiated", new Date(job.created).toISOString()) + "</Upload>").join(""))
}

import { listItems } from "../internal/op/storage"
import type { StorageRequestContext } from "../internal/op/storage"
import type { FileItem } from "../internal/driver/base"
import { fail, quoteETag } from "../internal/s3/protocol"
import { decimal, s3Xml, xmlTag } from "./s3-multipart"

type Entry = { key: string; item?: FileItem }

export function s3Timestamp(value: string | undefined): Date {
  const parsed = value ? new Date(value) : new Date(0)
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(0)
}

export async function listS3Objects(
  search: URLSearchParams,
  bucket: string,
  path: string,
  context: StorageRequestContext,
  mayRead: (path: string) => Promise<boolean>,
) {
  const prefix = search.get("prefix") ?? ""
  const delimiter = search.get("delimiter") ?? ""
  const listType = search.get("list-type")
  const v2 = listType === "2"
  const encoding = search.get("encoding-type")
  if ((delimiter && delimiter !== "/") || (listType && !v2) || (encoding && encoding !== "url")) {
    fail("InvalidArgument", "Unsupported list option")
  }
  if (prefix.split("/").some((part) => part === "." || part === ".." || /\.{3}|\\|[\x00-\x1f]|%[0-9a-f]{2}/i.test(part))) {
    fail("InvalidArgument", "Invalid list prefix")
  }

  const token = search.get("continuation-token")
  let after = (v2 ? search.get("start-after") : search.get("marker")) ?? ""
  if (token) {
    try {
      after = decodeURIComponent(atob(token))
    } catch {
      fail("InvalidArgument", "Invalid continuation token")
    }
  }
  const limit = decimal(search.get("max-keys"), 1000, 1000)
  const base = prefix.slice(0, prefix.lastIndexOf("/") + 1)
  const rows: Entry[] = []

  const walk = async (parent: string, stem: string) => {
    if (!await mayRead(parent)) return
    if (stem.split("/").length > 64) fail("InvalidRequest", "Object listing exceeds the supported directory depth")
    const result = await listItems(parent, context)
    const entries = result.content
      .filter(item => item.name && item.name !== "." && item.name !== ".." && !/[\/\\\x00-\x1f]|\.{3}|%[0-9a-f]{2}/i.test(item.name))
      .map((item) => ({ item, key: stem + item.name + (item.is_dir ? "/" : "") }))
      .sort((a, b) => a.key < b.key ? -1 : Number(a.key > b.key))
    for (const { item, key } of entries) {
      if (!key.startsWith(prefix) && (!item.is_dir || !prefix.startsWith(key))) continue
      const fullPath = path + "/" + key.replace(/\/$/, "")
      if (!await mayRead(fullPath)) continue
      if (item.is_dir && !delimiter) await walk(fullPath, key)
      else if (key > after) rows.push({ key, item: item.is_dir ? undefined : item })
      if (rows.length > limit) return
    }
  }

  if (limit) {
    try {
      await walk(path + (base ? "/" + base.slice(0, -1) : ""), base)
    } catch (error) {
      // Google Drive's path resolver reports a missing prefix as an exception.
      if (!base || !(error instanceof Error) || !/\[GoogleDrive\] Path '.*' not found/.test(error.message)) throw error
    }
  }
  const xmlKey = (name: string, key: string) => xmlTag(name, encoding ? encodeURIComponent(key) : key)
  const truncated = rows.length > limit
  const page = rows.slice(0, limit)
  const last = page.at(-1)?.key ?? ""
  const next = truncated
    ? v2 ? xmlTag("NextContinuationToken", btoa(encodeURIComponent(last))) : xmlKey("NextMarker", last)
    : ""
  return s3Xml("ListBucketResult",
    xmlTag("Name", bucket) + xmlKey("Prefix", prefix) + xmlTag("MaxKeys", limit) +
    (encoding ? xmlTag("EncodingType", encoding) : "") +
    (delimiter ? xmlKey("Delimiter", delimiter) : "") +
    (v2 ? xmlTag("KeyCount", page.length) : xmlKey("Marker", after)) +
    (token ? xmlTag("ContinuationToken", token) : "") + xmlTag("IsTruncated", truncated) + next +
    page.map(({ key, item }) => {
      if (!item) return "<CommonPrefixes>" + xmlKey("Prefix", key) + "</CommonPrefixes>"
      const md5 = item.hashes?.md5
      return "<Contents>" + xmlKey("Key", key) +
        xmlTag("LastModified", s3Timestamp(item.modified).toISOString()) +
        (md5 ? xmlTag("ETag", quoteETag(md5)) : "") +
        xmlTag("Size", item.size || 0) + xmlTag("StorageClass", "STANDARD") + "</Contents>"
    }).join(""))
}

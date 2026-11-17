import { Hono } from "hono"
import { authUserFromReq } from "./auth"
import { getDb } from "../internal/model/db"
import { fail, JOB_ID, quoteETag, S3Failure, uploadCall, uploadsEnabled } from "../internal/s3/protocol"
import type { UploadEnv, UploadStatus } from "../internal/s3/protocol"
import { verifyS3Signature } from "../internal/s3/sigv4"
import { handleUpload, listS3Uploads, s3Xml, stagedHead, uploadOperation, xmlEscape } from "./s3-multipart"
import { listS3Objects, s3Timestamp } from "./s3-list"
import {
  listItems,
  getItem,
  putItem,
  removeItems,
} from "../internal/op/storage"
import { safeErrorMessage } from "../pkg/errs"
import { appendDownloadSignToRawUrl } from "../pkg/sign"
import { readBodyWithinLimit } from "../pkg/upload-limit"
import {
  canRemove,
  canWrite,
  getActualPath,
  isAdmin,
  isWithinUserRoot,
} from "../pkg/permission"
import {
  canAccess,
  canWrite as canWriteMeta,
  canWriteContentBypassUserPerms,
  getNearestMeta,
} from "../pkg/meta"
import type { Meta } from "../pkg/meta"

/**
 * S3 网关使用 OpenList 用户的根目录、权限和目录规则。旧客户端仍可用 JWT，
 * Rclone 通过部署时配置的 SigV4 凭据映射到一个已有用户。
 *
 * 说明：本网关**不识别** settings.token 形式的静态 API Token —— 静态令牌走
 * 管理后台的 admin 鉴权通道，不是「某个用户」，无法映射到 S3 的对象视图。
 * 需要静态令牌访问的自动化场景请使用 /api/fs/* 接口。
 *
 * URL 结构：/s3/{bucket}/{objectKey}，bucket 是**用户根目录之下**的一级目录。
 *
 * 安全不变量（必须长期保持）：
 *   1. 认证用户必须存在且未被禁用（authUserFromReq 已复检 disabled）；
 *   2. 所有对象路径都必须落在该用户的 base_path 之内；
 *   3. 写操作（PutObject）需要 WRITE_CONTENT 权限位，
 *      删除操作（DeleteObject）需要 DELETE 权限位，管理员放行。
 *
 * 历史缺陷：只判断「是否登录」，随后直接操作全局虚拟路径 `/${bucket}/${key}`。
 * 后果有两条：① 任何已登录用户（含 permission=0 的只读用户、已禁用用户）都能
 * 上传/删除；② 受限 base_path 的用户可以读写其他用户的目录。均已修复。
 */

export const s3Router = new Hono()

function s3Error(code: string, message: string, status: number) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(message)}</Message></Error>`
  return new Response(xml, {
    status,
    headers: { "Content-Type": "application/xml", "x-amz-request-id": crypto.randomUUID() },
  })
}

s3Router.onError((error) => {
  if (error instanceof S3Failure) return s3Error(error.code, error.message, error.status)
  if (error instanceof URIError) return s3Error("InvalidArgument", "Invalid request path", 400)
  console.error("[s3] request failed", error.name)
  return s3Error("InternalError", "S3 request could not be completed", 500)
})

function isSigned(c: any) {
  return /^AWS4-/i.test(c.req.header("Authorization") ?? "")
}

function assertCanonicalPath(path: string) {
  if (/\\|[\x00-\x1f\x7f]|\.{3}|%[0-9a-f]{2}/i.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")) {
    fail("InvalidArgument", "Unsupported S3 path")
  }
}

/** 从 pathname 剥离 /s3 前缀，解析 { bucket, key } */
function parseS3Path(c: any): { bucket: string; key: string } {
  const pathname = new URL(c.req.url).pathname
  const p = pathname.replace(/^\/s3\/?/, "")
  const parts = p.split("/").filter(Boolean)
  const bucket = parts[0] || ""
  const key = parts.slice(1).map(decodeURIComponent).join("/")
  return { bucket, key }
}

/**
 * bucket / key 的语法校验。
 *
 * 只做「形状」校验：bucket 必须是单层目录名，key 不得含空段。真正的越界防护
 * 由 isWithinUserRoot() 在拼装完成后统一收口，不依赖这里。
 */
function isValidS3Bucket(bucket: string): boolean {
  if (!bucket) return false
  if (bucket === "." || bucket === "..") return false
  return !bucket.includes("/") && !bucket.includes("\\") && !bucket.includes("\0")
}

/**
 * 把 S3 的 { bucket, key } 映射为**用户根目录之下**的虚拟路径。
 *
 * base_path 为 "/" 的（默认）用户：`bucket/key` -> `/bucket/key`，与历史行为
 * 完全一致（bucket 即存储挂载点首段），不产生兼容性变化。
 * base_path 受限的用户：`bucket/key` -> `<base_path>/bucket/key`，把 S3 的
 * 「bucket」解释为该用户自己的顶层目录，从而与 /api/fs 的视图保持一致。
 */
function s3VirtualPath(user: any, bucket: string, key: string): string {
  const root = getActualPath(user, "/")
  const segments = [root, bucket, key].filter(Boolean).join("/")
  const normalized = ("/" + segments).replace(/\/{2,}/g, "/")
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

/** 统一的越界拒绝响应（403，避免暴露目标路径是否存在） */
function outOfScope(c: any) {
  return s3Error("AccessDenied", "Object is outside the user's root path", 403)
}

async function authUser(c: any): Promise<any | null> {
  if (isSigned(c)) {
    if (!uploadsEnabled(c.env)) fail("AccessDenied", "S3 signing is unavailable", 403)
    const id = await verifyS3Signature(c.req.raw, c.env)
    const db = await getDb(c.env)
    return db.users?.find((user: any) => user.id === id && !user.disabled) ?? null
  }
  const auth = await authUserFromReq(c)
  return auth ? auth.user : null
}

/**
 * 目录级（meta）访问控制——与 /api/fs/* 共用同一套判定。
 *
 * 安全不变量：S3 网关不得成为「绕过目录密码 / read_users / write_users」的
 * 第二条通道，否则站内被保护的路径可以经 /s3 直接读写。
 *
 * S3 协议没有传递目录密码的标准位置，这里接受 `?pwd=` 查询参数或
 * `x-meta-password` 请求头作为 meta 密码来源。
 */
const metaPasswordOf = (c: any): string =>
  c.req.query("pwd") || c.req.header("x-meta-password") || ""

async function loadMeta(c: any, path: string): Promise<Meta | null> {
  try {
    return await getNearestMeta(path, c.env)
  } catch (error) {
    if (isSigned(c)) throw error
    return null
  }
}

/** 读路径的 meta 判定：密码保护 + read_users 白名单。返回 true 表示拒绝。 */
async function metaReadDenied(
  c: any,
  user: any,
  path: string,
): Promise<boolean> {
  const meta = await loadMeta(c, path)
  if (!meta) return false
  return !canAccess(user, meta, path, metaPasswordOf(c))
}

/**
 * 写路径的 meta 判定：WRITE_CONTENT 权限位（或 meta.write 强制开放）
 * + meta.write_users 白名单。返回 true 表示拒绝。
 */
async function metaWriteDenied(
  c: any,
  user: any,
  path: string,
): Promise<boolean> {
  const meta = await loadMeta(c, path)
  if (!meta) return false
  if (isAdmin(user)) return false
  if (!canWrite(user) && !canWriteContentBypassUserPerms(meta, path)) {
    return true
  }
  return !canWriteMeta(user, meta, path)
}

const getCtx = (c: any) => {
  try {
    const ec = c.executionCtx
    return ec && typeof ec.waitUntil === "function"
      ? { waitUntil: (p: Promise<unknown>) => ec.waitUntil(p), env: c.env }
      : { env: c.env }
  } catch {
    return { env: c?.env }
  }
}

// GET /s3/ → ListBuckets
async function rootS3(c: any): Promise<Response> {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  if (new URL(c.req.url).searchParams.has("openlist-quota")) {
    if (!isAdmin(user) || !uploadsEnabled(c.env)) return s3Error("AccessDenied", "Administrator required", 403)
    return Response.json(await uploadCall(c.env, "quota", {}), { headers: { "Cache-Control": "no-store" } })
  }
  try {
    // 仅列出用户根目录之下的「bucket」——受限 base_path 的用户不应看到整站挂载点
    const res = await listItems(getActualPath(user, "/"), getCtx(c))
    const buckets = (res.content || [])
      .filter((it: any) => it.is_dir)
      .map(
        (it: any) =>
          `  <Bucket><Name>${xmlEscape(it.name)}</Name><CreationDate>${xmlEscape(it.modified || new Date().toISOString())}</CreationDate></Bucket>`,
      )
      .join("\n")
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>openlist</ID><DisplayName>openlist</DisplayName></Owner>
  <Buckets>
${buckets}
  </Buckets>
</ListAllMyBucketsResult>`
    return new Response(xml, {
      status: 200,
      headers: { "Content-Type": "application/xml" },
    })
  } catch (e: any) {
    return s3Error("InternalError", safeErrorMessage(e), 500)
  }
}

s3Router.get("/", rootS3)

s3Router.post("/", async (c) => {
  const query = new URL(c.req.url).searchParams
  if (!query.has("openlist-discard")) return s3Error("InvalidArgument", "Invalid bucket/key", 400)
  const auth = await authUserFromReq(c)
  if (!auth || !isAdmin(auth.user)) return s3Error("AccessDenied", "Administrator required", 403)
  const ids = query.getAll("uploadId")
  if (ids.length !== 1 || !JOB_ID.test(ids[0])) fail("InvalidArgument", "Exactly one valid upload ID is required")
  const env = c.env as Partial<UploadEnv> | undefined
  if (!uploadsEnabled(env)) fail("ServiceUnavailable", "S3 staging bindings or mode are unavailable", 503)
  return c.json(await uploadCall<UploadStatus>(env, "discard", { id: ids[0] }), 200, {
    "Cache-Control": "no-store",
  })
})

// Hono dispatches HEAD through GET and strips the response body.
s3Router.get("/*", async (c) => {
  const { bucket, key } = parseS3Path(c)
  if (!bucket) return rootS3(c)
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  if (!isValidS3Bucket(bucket)) return s3Error("NoSuchBucket", "NoSuchBucket", 404)
  const request = c.req.raw
  const signed = isSigned(c)
  const virtualPath = s3VirtualPath(user, bucket, key)
  if (!isWithinUserRoot(user, virtualPath)) return outOfScope(c)
  if (signed) assertCanonicalPath(virtualPath)
  if (await metaReadDenied(c, user, virtualPath)) {
    return s3Error("AccessDenied", "Read permission denied for this path", 403)
  }
  const head = request.method === "HEAD"
  const query = new URL(request.url).searchParams
  if (!key) {
    const { item } = await getItem(virtualPath, getCtx(c)).catch(() => ({ item: null }))
    if (!item?.is_dir) return s3Error("NoSuchBucket", "NoSuchBucket", 404)
    if (head) return new Response(null, { headers: { "x-amz-bucket-region": "us-east-1" } })
    if (query.has("location")) return s3Xml("LocationConstraint", "")
    if (query.has("uploads")) {
      if (!canWrite(user)) return s3Error("AccessDenied", "Write permission required", 403)
      return listS3Uploads(request, c.env as any, { owner: user.id, path: virtualPath }, bucket)
    }
    return listS3Objects(query, bucket, virtualPath, getCtx(c), async (path) =>
      isWithinUserRoot(user, path) && !await metaReadDenied(c, user, path),
    )
  }
  if (uploadOperation(request, signed)) {
    assertCanonicalPath(virtualPath)
    return handleUpload(request, c.env as any, { owner: user.id, path: virtualPath }, bucket, key)
  }
  if (head && signed && uploadsEnabled(c.env as any)) {
    const staged = await uploadCall<UploadStatus | null>(c.env as any, "head", { owner: user.id, path: virtualPath })
    if (staged) return stagedHead(staged)
  }

  try {
    const { item, rawUrl } = await getItem(virtualPath, getCtx(c))
    if (!item || item.is_dir) return s3Error("NoSuchKey", "NoSuchKey", 404)
    if (head) {
      const modified = s3Timestamp(item.modified)
      const md5 = item.hashes?.md5
      return new Response(null, {
        headers: {
          "Content-Length": String(item.size || 0),
          "Content-Type": "application/octet-stream",
          "Last-Modified": modified.toUTCString(),
          "x-amz-meta-mtime": String(modified.getTime() / 1000),
          ...(md5 ? { ETag: quoteETag(md5) } : {}),
        },
      })
    }
    if (rawUrl) {
      // /d and /p use the same download signatures as WebDAV and the file API.
      return c.redirect(await appendDownloadSignToRawUrl(c, rawUrl, virtualPath), 302)
    }
    return s3Error("NoSuchKey", "NoSuchKey", 404)
  } catch (error) {
    return s3Error("NoSuchKey", safeErrorMessage(error), 404)
  }
})

s3Router.post("/*", async (c) => {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  const { bucket, key } = parseS3Path(c)
  if (!isValidS3Bucket(bucket) || !key) return s3Error("InvalidArgument", "Invalid bucket/key", 400)
  const path = s3VirtualPath(user, bucket, key)
  if (!isWithinUserRoot(user, path)) return outOfScope(c)
  assertCanonicalPath(path)
  return handleUpload(c.req.raw, c.env as any, { owner: user.id, path }, bucket, key)
})

// PUT /s3/{bucket}/{key} → PutObject
s3Router.put("/*", async (c) => {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  // 写操作必须持有 WRITE_CONTENT 权限位（管理员放行）。
  // 历史缺陷：只判断「是否登录」，任何已认证用户（含只读用户）都能上传。
  if (!canWrite(user)) {
    return s3Error("AccessDenied", "Write permission required", 403)
  }
  const { bucket, key } = parseS3Path(c)
  if (!isValidS3Bucket(bucket) || !key) {
    return s3Error("InvalidArgument", "Invalid bucket/key", 400)
  }
  const virtualPath = s3VirtualPath(user, bucket, key)
  if (!isWithinUserRoot(user, virtualPath)) return outOfScope(c)
  if (uploadOperation(c.req.raw, isSigned(c))) {
    assertCanonicalPath(virtualPath)
    return handleUpload(c.req.raw, c.env as any, { owner: user.id, path: virtualPath }, bucket, key)
  }
  // 目录级写判定（对齐 /api/fs/put 的 meta.write_users 与 write_content_bypass）
  const parentDir =
    virtualPath.lastIndexOf("/") > 0
      ? virtualPath.slice(0, virtualPath.lastIndexOf("/"))
      : "/"
  if (await metaWriteDenied(c, user, parentDir)) {
    return s3Error("AccessDenied", "Write permission denied for this path", 403)
  }
  try {
    // 体积上限按**实际收到的字节数**判定（与 /fs/put 共用 pkg/upload-limit）。
    // 历史缺陷：PutObject 完全没有大小限制，MAX_UPLOAD/MAX_UPPART 都不生效，
    // 超大请求体会被整包读入内存——与 /fs/put 的防护形成明显不对称。
    const body = await readBodyWithinLimit(c, false)
    if (!body.ok) {
      return s3Error(
        "EntityTooLarge",
        `Object exceeds the ${body.limit} byte limit`,
        400,
      )
    }
    await putItem(virtualPath, body.buffer, getCtx(c))
    // 不再返回伪造的 ETag。
    //
    // 历史实现返回 `Date.now().toString(16)`，不是内容摘要：依赖 ETag 做幂等/
    // 续传/校验的客户端（rclone、aws-cli 等）会记录一个永不对应的值。真实 S3
    // 对单次 PUT 返回内容 MD5，但本运行时没有便宜的 MD5 通道（WebCrypto 不提供
    // MD5；纯 JS 实现要整包多扫一遍；hash-wasm 的 WASM 在边缘运行时可能被禁止，
    // 见 internal/seed/hashers.ts），因此这里选择**不返回 ETag**——宁可缺失，
    // 也不给出错误的摘要；真实摘要（含分片 ETag 语义）留作后续跟进。
    return new Response(null, { status: 200 })
  } catch (e: any) {
    return s3Error("InternalError", safeErrorMessage(e), 500)
  }
})

// DELETE /s3/{bucket}/{key} → DeleteObject
s3Router.delete("/*", async (c) => {
  const user = await authUser(c)
  if (!user) return s3Error("AccessDenied", "Authentication required", 403)
  const { bucket, key } = parseS3Path(c)
  if (!isValidS3Bucket(bucket) || !key) {
    return s3Error("InvalidArgument", "Invalid bucket/key", 400)
  }
  const virtualPath = s3VirtualPath(user, bucket, key)
  if (!isWithinUserRoot(user, virtualPath)) return outOfScope(c)
  if (uploadOperation(c.req.raw, isSigned(c))) {
    assertCanonicalPath(virtualPath)
    return handleUpload(c.req.raw, c.env as any, { owner: user.id, path: virtualPath }, bucket, key)
  }
  if (isSigned(c)) assertCanonicalPath(virtualPath)
  // 删除操作必须持有 DELETE 权限位（管理员放行）。
  if (!canRemove(user)) {
    return s3Error("AccessDenied", "Delete permission required", 403)
  }
  // 目录级写判定（对齐 /api/fs/remove 的 meta.write_users）
  if (await metaWriteDenied(c, user, virtualPath)) {
    return s3Error("AccessDenied", "Write permission denied for this path", 403)
  }
  // 以目标对象自身的虚拟路径为基准拆出父目录与文件名，避免 bucket 边界下的错位
  const slash = virtualPath.lastIndexOf("/")
  const dir = slash > 0 ? virtualPath.slice(0, slash) : "/"
  const name = virtualPath.slice(slash + 1)
  try {
    await removeItems(dir, [name], getCtx(c))
    return new Response(null, { status: 204 })
  } catch (e: any) {
    return s3Error("NoSuchKey", safeErrorMessage(e), 404)
  }
})

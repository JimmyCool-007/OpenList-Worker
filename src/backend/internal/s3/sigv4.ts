import {
  getSigningKey,
  hmacSha256Hex,
  rfc3986UriEncode,
  sha256Hex,
} from "../../drivers/s3/sigv4"
import { fail } from "./protocol"
import type { UploadEnv } from "./protocol"

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

export async function verifyS3Signature(request: Request, env: Partial<UploadEnv>): Promise<number> {
  const auth = request.headers.get("authorization") ?? ""
  const match = /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/(\d{8})\/([a-z0-9-]+)\/s3\/aws4_request,\s*SignedHeaders=([a-z0-9;-]+),\s*Signature=([a-f0-9]{64})$/.exec(auth)
  const userId = Number(env.S3_USER_ID)
  if (!match || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY ||
      match[1] !== env.S3_ACCESS_KEY_ID || !Number.isSafeInteger(userId) || userId <= 0) {
    fail("AccessDenied", "Invalid S3 credentials", 403)
  }
  const [, , day, region, signed, signature] = match
  const date = request.headers.get("x-amz-date") ?? ""
  const timestamp = date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z")
  if (!/^\d{8}T\d{6}Z$/.test(date) || date.slice(0, 8) !== day ||
      !Number.isFinite(Date.parse(timestamp)) || Math.abs(Date.now() - Date.parse(timestamp)) > 15 * 60_000) {
    fail("RequestTimeTooSkewed", "Signature timestamp is outside the permitted window", 403)
  }
  const url = new URL(request.url)
  const names = signed.split(";")
  if (!names.includes("host") || !names.includes("x-amz-date") ||
      names.some((name, i) => i > 0 && name <= names[i - 1])) {
    fail("SignatureDoesNotMatch", "Invalid signed headers", 403)
  }
  for (const [name] of request.headers) {
    if ((name === "content-md5" || name.startsWith("x-amz-meta-") || name === "x-amz-mp-object-size") &&
        !names.includes(name)) {
      fail("SignatureDoesNotMatch", "Upload checksum and metadata headers must be signed", 403)
    }
  }
  // Cloudflare rewrites Accept-Encoding and exposes the original value in request metadata.
  const clientAcceptEncoding = (request as Request & { cf?: { clientAcceptEncoding?: string | null } })
    .cf?.clientAcceptEncoding
  const headers = names.map((name) => {
    let value = name === "host" ? url.host : request.headers.get(name)
    if (name === "accept-encoding" && typeof clientAcceptEncoding === "string") {
      value = clientAcceptEncoding
    }
    if (value === null) fail("SignatureDoesNotMatch", "Missing signed header", 403)
    return name + ":" + value.trim().replace(/\s+/g, " ") + "\n"
  }).join("")
  const query = Array.from(url.searchParams, ([key, value]) =>
    rfc3986UriEncode(key) + "=" + rfc3986UriEncode(value)).sort().join("&")
  // S3 signs the escaped wire path, including the endpoint's /s3 prefix.
  const payload = request.headers.get("x-amz-content-sha256") ?? EMPTY_SHA256
  if (payload !== "UNSIGNED-PAYLOAD" && !/^[a-f0-9]{64}$/.test(payload)) {
    fail("NotImplemented", "AWS chunked payloads are unsupported", 501)
  }
  if (payload === "UNSIGNED-PAYLOAD" && url.protocol !== "https:") {
    fail("AccessDenied", "Unsigned payloads require HTTPS", 403)
  }
  const canonical = [request.method, url.pathname, query, headers, signed, payload].join("\n")
  const scope = [day, region, "s3", "aws4_request"].join("/")
  const toSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonical)].join("\n")
  const expected = await hmacSha256Hex(
    await getSigningKey(env.S3_SECRET_ACCESS_KEY, day, region, "s3"), toSign,
  )
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  if (difference !== 0) {
    fail("SignatureDoesNotMatch", "The S3 signature did not match", 403)
  }
  return userId
}

export function payloadSHA256(request: Request): string | undefined {
  const value = request.headers.get("x-amz-content-sha256")
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined
}

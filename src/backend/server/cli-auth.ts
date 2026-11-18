import type { Context } from "hono"
import { authUserFromReq, checkUserOtp, verifyUserPassword } from "./auth"
import { getDb } from "../internal/model/db"
import type { CliSession } from "../durable-objects/CliState"
import type { UploadEnv } from "../internal/s3/protocol"
import { fail } from "../internal/s3/protocol"
import { isAdmin, isGuest, type UserPermissionObj } from "../pkg/permission"

export type CliUser = UserPermissionObj & { id: number; username: string; password?: string; otp_secret?: string }
export type CliEnv = UploadEnv & { CLI_STATE: UploadEnv["S3_UPLOADS"] }

function hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}

export async function digest(text: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
}

export async function cliState<T>(env: CliEnv, action: string, payload: object): Promise<T> {
  if (!env.CLI_STATE) fail("Unavailable", "CLI state is unavailable", 503)
  const stub = env.CLI_STATE.get(env.CLI_STATE.idFromName("cli-state-v1"))
  const response = await stub.fetch(new Request("https://openlist-cli.internal/" + action, {
    method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" },
  }))
  if (!response.ok) fail("Unavailable", "CLI state is unavailable", 503)
  return response.json() as Promise<T>
}

export async function cliJson(request: Request, limit = 128 * 1024): Promise<any> {
  if (!request.body) fail("InvalidRequest", "JSON body is required", 400)
  const reader = request.body.getReader()
  const bytes = new Uint8Array(limit)
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      if (part.value.length + length > limit) {
        await reader.cancel()
        fail("InvalidRequest", "Request is too large", 413)
      }
      bytes.set(part.value, length)
      length += part.value.length
    }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error()
    return data
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error
    fail("InvalidRequest", "Invalid JSON body", 400)
  } finally {
    reader.releaseLock()
  }
}

function tokenHash(c: Context) {
  const token = /^Bearer (ol_[0-9a-f]{64})$/.exec(c.req.header("Authorization") ?? "")?.[1]
  if (!token) fail("Unauthorized", "Run ol login", 401)
  return digest(token)
}

function securityStamp(user: CliUser) {
  return digest(JSON.stringify([user.password, user.otp_secret, user.username]))
}

export async function currentCliUser(c: Context) {
  const hash = await tokenHash(c)
  const session = await cliState<CliSession | null>(c.env, "lookup", { hash })
  if (!session) fail("Unauthorized", "Session expired or revoked. Run ol login", 401)
  const db = await getDb(c.env)
  const user: CliUser | undefined = db.users?.find((u: CliUser) => u.id === session.userId)
  if (!user || user.disabled || isGuest(user) || await securityStamp(user) !== session.stamp) {
    await cliState(c.env, "revoke", { hash })
    fail("Unauthorized", "Account credentials or access changed. Run ol login", 401)
  }
  return { user, expiresAt: session.expiresAt }
}

export async function loginCli(c: Context) {
  const data = await cliJson(c.req.raw, 12 * 1024)
  const username = typeof data.username === "string" ? data.username.trim() : ""
  if (!username || username.length > 256 || typeof data.password !== "string" ||
      !data.password || data.password.length > 4096 ||
      (data.otp_code !== undefined && (typeof data.otp_code !== "string" || data.otp_code.length > 32))) {
    fail("InvalidCredentials", "Invalid credentials", 401)
  }
  const [ip, account] = await Promise.all([
    digest("ip:" + (c.req.header("CF-Connecting-IP") || "unknown")),
    digest("account:" + username.toLowerCase()),
  ])
  const { allowed } = await cliState<{ allowed: boolean }>(c.env, "rate", { ip, account })
  if (!allowed) fail("RateLimited", "Too many login attempts. Try again in 10 minutes", 429)
  const db = await getDb(c.env)
  const user: CliUser | undefined = db.users?.find((u: CliUser) => u.username === username)
  if (!user || user.disabled || isGuest(user) || !await verifyUserPassword(user, data.password)) {
    fail("InvalidCredentials", "Invalid credentials", 401)
  }
  const otp = await checkUserOtp(user, { otp_code: data.otp_code })
  if (!otp.ok) {
    if (otp.code === 402) fail("OTPRequired", "One-time code required", 401)
    fail("InvalidCredentials", "Invalid credentials", 401)
  }
  const token = "ol_" + hex(crypto.getRandomValues(new Uint8Array(32)))
  const [hash, stamp] = await Promise.all([digest(token), securityStamp(user)])
  const { expiresAt } = await cliState<{ expiresAt: number | null }>(
    c.env, "create", { hash, userId: user.id, stamp },
  )
  if (!expiresAt) fail("SessionLimit", "Too many active sessions. Revoke an existing session first", 429)
  return c.json({ token, expiresAt, userId: user.id, username: user.username })
}

export async function logoutCli(c: Context) {
  await cliState(c.env, "revoke", { hash: await tokenHash(c) })
  return c.body(null, 204)
}

export async function revokeUserCli(c: Context) {
  // This endpoint requires an existing OpenList administrator JWT.
  const auth = await authUserFromReq(c)
  if (!auth || !isAdmin(auth.user)) fail("AccessDenied", "OpenList administrator authentication required", 403)
  const { userId } = await cliJson(c.req.raw, 1024)
  if (!Number.isSafeInteger(userId) || userId < 0) fail("InvalidRequest", "Invalid user ID", 400)
  await cliState(c.env, "revoke-user", { userId })
  return c.body(null, 204)
}

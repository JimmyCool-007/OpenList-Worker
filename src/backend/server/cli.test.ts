import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { sign } from "hono/jwt"
import { CliState, CLI_SESSION_MS } from "../durable-objects/CliState"
import { __resetDbCacheForTest, __setStoreBackendLoaderForTest } from "../internal/model/db"
import type { LedgerStorage } from "../internal/s3/ledger"
import { setUserPassword } from "../pkg/password"
import { generateTotpCode, generateTotpSecret } from "../pkg/totp"
import { cliRouter } from "./cli"

function dbStorage() {
  const sqlite = new DatabaseSync(":memory:")
  const storage: LedgerStorage = {
    sql: {
      exec(query, ...args) {
        const rows = sqlite.prepare(query).all(...args)
        return { toArray: () => rows }
      },
    },
    transactionSync(fn) {
      sqlite.exec("BEGIN")
      try {
        const result = fn()
        sqlite.exec("COMMIT")
        return result
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
    async sync() {},
    async getAlarm() { return null },
    async setAlarm() {},
  }
  return { storage, sqlite }
}

test("Worker CLI login, expiry, logout, admin revocation and current permissions", async t => {
  const { storage, sqlite } = dbStorage()
  t.after(() => sqlite.close())
  const authState = new CliState({ storage })
  const alice = { id: 7, role: 0, username: "alice", disabled: false, permission: 1 << 3, base_path: "/drive" }
  const admin = { id: 8, role: 2, username: "admin", disabled: false, permission: 0, base_path: "/", pwd_update_at: "" }
  await setUserPassword(alice, "only a test")
  const source = { users: [alice, admin], settings: [], metas: [], storages: [], shares: [], plugins: [] }
  __resetDbCacheForTest()
  __setStoreBackendLoaderForTest(async () => ({
    name: "cli-test",
    async isConfigured() { return true },
    async load() { return structuredClone(source) },
    async save() { return true },
  }))
  const env = {
    JWT_SECRET: "worker-cli-tests-only-secret-value",
    CLI_STATE: { idFromName: () => "test", get: () => authState },
  }
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  function call(route: string, token = "", data?: object, method = "GET") {
    const headers = new Headers({ "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" })
    if (token) headers.set("Authorization", "Bearer " + token)
    return cliRouter.request(new Request("https://cli.example" + route, {
      method, headers, body: data && JSON.stringify(data),
    }), undefined, { ...env })
  }
  const login = (password = "only a test") => call("/login", "", { username: "alice", password }, "POST")
  assert.equal((await login("wrong")).status, 401)
  const first = await (await login()).json() as { token: string; expiresAt: number }
  const second = await (await login()).json() as typeof first
  assert.equal(first.expiresAt - now, 30 * 24 * 60 * 60 * 1000)
  assert.equal(CLI_SESSION_MS, first.expiresAt - now)
  assert.match(first.token, /^ol_[a-f0-9]{64}$/)
  assert.notEqual(first.token, second.token)
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT hash FROM cli_sessions").all()).includes(first.token))
  assert.equal((await call("/whoami", first.token)).status, 200)

  assert.equal((await call("/admin/revoke", first.token, { userId: 7 }, "POST")).status, 403)
  assert.equal((await call("/stat?path=..%2Fother", first.token)).status, 400)
  assert.equal((await call("/stat?path=%252e%252e", first.token)).status, 400)
  assert.equal((await call("/logout", first.token, undefined, "POST")).status, 204)
  assert.equal((await call("/whoami", first.token)).status, 401)
  assert.equal((await call("/whoami", second.token)).status, 200)

  alice.permission = 0
  assert.equal((await call("/mkdir", second.token, { path: "private" }, "POST")).status, 403)
  alice.base_path = "/other"
  assert.equal((await call("/stat?path=secret", second.token)).status, 403)
  alice.base_path = "/drive"
  alice.disabled = true
  assert.equal((await call("/whoami", second.token)).status, 401)
  assert.equal((await login()).status, 401)
  alice.disabled = false

  const third = await (await login()).json() as typeof first
  const jwt = await sign({ id: admin.id, username: admin.username, pwd_ts: "", exp: Math.floor(now / 1000) + 60 }, env.JWT_SECRET)
  assert.equal((await call("/admin/revoke", jwt, { userId: 7 }, "POST")).status, 204)
  assert.equal((await call("/whoami", third.token)).status, 401)

  const fourth = await (await login()).json() as typeof first
  now = fourth.expiresAt - 1
  assert.equal((await call("/whoami", fourth.token)).status, 200)
  now++
  assert.equal((await call("/whoami", fourth.token)).status, 401)

  Object.assign(alice, { otp_secret: generateTotpSecret() })
  assert.equal((await (await login()).json() as { code: string }).code, "OTPRequired")
  assert.equal((await call("/login", "", {
    username: "alice", password: "only a test", otp_code: await generateTotpCode((alice as any).otp_secret),
  }, "POST")).status, 200)
  for (let i = 0; i < 8; i++) assert.equal((await login("wrong")).status, 401)
  assert.equal((await login()).status, 429)
})

import type { LedgerStorage } from "../internal/s3/ledger"

export const CLI_SESSION_MS = 30 * 24 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 10 * 60 * 1000

export type CliSession = { userId: number; stamp: string; expiresAt: number }

export class CliState {
  constructor(private readonly state: { storage: LedgerStorage }) {
    const { sql } = state.storage
    sql.exec("CREATE TABLE IF NOT EXISTS cli_sessions (hash TEXT PRIMARY KEY, user INTEGER NOT NULL, stamp TEXT NOT NULL, expiry INTEGER NOT NULL)")
    sql.exec("CREATE INDEX IF NOT EXISTS cli_sessions_user ON cli_sessions(user)")
    sql.exec("CREATE INDEX IF NOT EXISTS cli_sessions_expiry ON cli_sessions(expiry)")
    sql.exec("CREATE TABLE IF NOT EXISTS cli_login (key TEXT PRIMARY KEY, expiry INTEGER NOT NULL, hits INTEGER NOT NULL)")
    sql.exec("CREATE INDEX IF NOT EXISTS cli_login_expiry ON cli_login(expiry)")
    sql.exec("CREATE TABLE IF NOT EXISTS cli_folders (key TEXT PRIMARY KEY, drive_id TEXT NOT NULL, expiry INTEGER NOT NULL)")
    sql.exec("CREATE INDEX IF NOT EXISTS cli_folders_expiry ON cli_folders(expiry)")
  }

  async fetch(request: Request): Promise<Response> {
    const data = await request.json() as {
      hash: string; userId: number; stamp: string; ip: string; account: string
      key: string; proposed: string
    }
    const { sql } = this.state.storage
    const now = Date.now()
    switch (new URL(request.url).pathname) {
      case "/rate": {
        const allowed = this.state.storage.transactionSync(() => {
          sql.exec("DELETE FROM cli_login WHERE expiry <= ?", now)
          const keys = [data.ip, data.account]
          const counts = keys.map(key => Number(sql.exec(
            "SELECT hits FROM cli_login WHERE key = ?", key,
          ).toArray()[0]?.hits ?? 0))
          if (counts[0] >= 30 || counts[1] >= 10) return false
          for (const key of keys) {
            sql.exec("INSERT INTO cli_login VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET hits = hits + 1",
              key, now + LOGIN_WINDOW_MS)
          }
          return true
        })
        return Response.json({ allowed })
      }
      case "/create": {
        const expiresAt = now + CLI_SESSION_MS
        const created = this.state.storage.transactionSync(() => {
          sql.exec("DELETE FROM cli_sessions WHERE expiry <= ?", now)
          const count = Number(sql.exec("SELECT COUNT(*) AS n FROM cli_sessions WHERE user = ?", data.userId).toArray()[0].n)
          if (count >= 100) return false
          sql.exec("INSERT INTO cli_sessions VALUES (?, ?, ?, ?)", data.hash, data.userId, data.stamp, expiresAt)
          return true
        })
        return Response.json({ expiresAt: created ? expiresAt : null })
      }
      case "/lookup": {
        const [session] = sql.exec("SELECT user AS userId, stamp, expiry AS expiresAt FROM cli_sessions WHERE hash = ? AND expiry > ?",
          data.hash, now).toArray()
        return Response.json(session ?? null)
      }
      case "/revoke":
        sql.exec("DELETE FROM cli_sessions WHERE hash = ?", data.hash)
        return Response.json({ ok: true })
      case "/revoke-user":
        sql.exec("DELETE FROM cli_sessions WHERE user = ?", data.userId)
        return Response.json({ ok: true })
      case "/folder-id": {
        const id = this.state.storage.transactionSync(() => {
          sql.exec("DELETE FROM cli_folders WHERE expiry <= ?", now)
          const [existing] = sql.exec("SELECT drive_id FROM cli_folders WHERE key = ?", data.key).toArray()
          if (existing) return existing.drive_id
          if (!data.proposed) return null
          sql.exec("INSERT INTO cli_folders VALUES (?, ?, ?)", data.key, data.proposed, now + CLI_SESSION_MS)
          return data.proposed
        })
        return Response.json(id)
      }
      case "/forget-folder":
        sql.exec("DELETE FROM cli_folders WHERE key = ? AND drive_id = ?", data.key, data.proposed)
        return Response.json({ ok: true })
      default:
        return new Response(null, { status: 404 })
    }
  }
}

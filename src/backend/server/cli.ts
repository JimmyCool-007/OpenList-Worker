import { Hono, type Context } from "hono"
import { DriveUploadError } from "../drivers/google_drive/resumable"
import {
  checkedSize, fail, JOB_ID, MAX_FILE_SIZE, MIN_PART_SIZE, S3_CHUNK_SIZE, S3Failure, uploadCall, uploadsEnabled,
  type Manifest, type UploadStatus,
} from "../internal/s3/protocol"
import { authorizeUpload } from "../internal/s3/target"
import { cliJson, currentCliUser, loginCli, logoutCli, revokeUserCli, type CliEnv, type CliUser } from "./cli-auth"
import { authorizeCliPath, cliDownload, cliList, cliPath, cliRoot, cliStat, ensureCliFolder, mayRead } from "./cli-drive"

export const cliRouter = new Hono()
type Task = UploadStatus & { path: string; transferring: boolean }

cliRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store")
  await next()
})

cliRouter.onError((error, c) => {
  if (error instanceof S3Failure) {
    return c.json({ code: error.code, message: error.message }, { status: error.status as 400 })
  }
  if (error instanceof DriveUploadError) {
    const status = [403, 404, 409].includes(error.status) ? error.status : 503
    return c.json({ code: "DriveError", message: error.message }, { status: status as 400 })
  }
  console.warn("[ol] request failed", error.name)
  return c.json({ code: "Unavailable", message: "OpenList could not complete the CLI request" }, 503)
})

cliRouter.post("/login", loginCli)
cliRouter.post("/logout", logoutCli)
cliRouter.post("/admin/revoke", revokeUserCli)
cliRouter.get("/whoami", async c => {
  const { user, expiresAt } = await currentCliUser(c)
  return c.json({ userId: user.id, username: user.username, expiresAt, root: cliRoot(user), maxFileSize: MAX_FILE_SIZE })
})

function staging(c: Context) {
  const env = c.env as CliEnv
  if (!uploadsEnabled(env)) fail("Unavailable", "R2 staging is unavailable on this Worker", 503)
  return env
}

cliRouter.get("/stat", async c => {
  const { user } = await currentCliUser(c)
  const path = cliPath(user, c.req.query("path") ?? "")
  await authorizeCliPath(c.env as CliEnv, user, path)
  return c.json(await cliStat(c.env as CliEnv, path))
})

cliRouter.get("/list", async c => {
  const { user } = await currentCliUser(c)
  const path = cliPath(user, c.req.query("path") ?? "")
  const cursor = c.req.query("cursor") ?? ""
  if (cursor.length > 4096) fail("InvalidCursor", "Invalid cursor", 400)
  await authorizeCliPath(c.env as CliEnv, user, path)
  return c.json(await cliList(c.env as CliEnv, user, path, cursor))
})

cliRouter.post("/mkdir", async c => {
  const { user } = await currentCliUser(c)
  const data = await cliJson(c.req.raw, 24 * 1024)
  const path = cliPath(user, data.path)
  await authorizeCliPath(c.env as CliEnv, user, path, true)
  await ensureCliFolder(c.env as CliEnv, path)
  return c.body(null, 204)
})

cliRouter.get("/download", async c => {
  const { user } = await currentCliUser(c)
  const path = cliPath(user, c.req.query("path") ?? "")
  await authorizeCliPath(c.env as CliEnv, user, path)
  return cliDownload(c.env as CliEnv, path, c.req.raw)
})

function publicTask(task: Task, root: string) {
  return { ...task, path: task.path.slice(root.length).replace(/^\//, "") }
}

cliRouter.get("/tasks", async c => {
  const { user } = await currentCliUser(c)
  const env = staging(c)
  const root = cliRoot(user)
  const after = c.req.query("cursor") ?? ""
  if (after && !JOB_ID.test(after)) fail("InvalidCursor", "Invalid cursor", 400)
  const tasks = await uploadCall<Task[]>(env, "cli-tasks", { owner: user.id, path: root, after, limit: 100 })
  const visible = []
  for (const task of tasks) {
    if (await mayRead(env, user, task.path, root)) visible.push(publicTask(task, root))
  }
  return c.json({ entries: visible, next: tasks.length === 100 ? tasks.at(-1)!.id : "" })
})

async function ownedTask(env: CliEnv, user: CliUser, id: string) {
  if (!JOB_ID.test(id)) fail("NoSuchUpload", "Upload was not found", 404)
  const root = cliRoot(user)
  const task = await uploadCall<Task>(env, "cli-task", { owner: user.id, id })
  if (!await mayRead(env, user, task.path, root)) fail("NoSuchUpload", "Upload was not found", 404)
  return task
}

async function details(c: Context, write = false) {
  const { user } = await currentCliUser(c)
  const env = staging(c)
  const id = c.req.param("id") ?? ""
  const task = await ownedTask(env, user, id)
  if (write) {
    await authorizeCliPath(env, user, task.path, true)
    await authorizeUpload(env, { owner: user.id, path: task.path })
  }
  return { task, env, user, scope: { owner: user.id, path: task.path, id } }
}

cliRouter.get("/tasks/:id", async c => {
  const { task, user } = await details(c)
  return c.json(publicTask(task, cliRoot(user)))
})

cliRouter.post("/tasks", async c => {
  const { user } = await currentCliUser(c)
  const env = staging(c)
  const { path: relative, id, size, partSize, md5, sha256 } = await cliJson(c.req.raw, 24 * 1024)
  const path = cliPath(user, relative)
  if (typeof id !== "string" || !JOB_ID.test(id) || !Number.isSafeInteger(size) || size < 0 ||
      !Number.isSafeInteger(partSize) || partSize < MIN_PART_SIZE || partSize > S3_CHUNK_SIZE ||
      typeof md5 !== "string" || !/^[a-f0-9]{32}$/.test(md5) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    fail("InvalidUpload", "Invalid file size, checksum, chunk size or task ID", 400)
  }
  if (size > MAX_FILE_SIZE) fail("EntityTooLarge", "Single-file limit is 5,000,000,000 bytes", 413)
  await authorizeCliPath(env, user, path, true)
  const task = await uploadCall<Task>(env, "cli-create", {
    owner: user.id, path, id, size, metadata: { md5, contentType: "application/octet-stream" },
    cli: { size, partSize, sha256 }, checksums: { md5 },
  })
  return c.json(publicTask(task, cliRoot(user)))
})

cliRouter.get("/tasks/:id/parts", async c => {
  const { env, scope } = await details(c, true)
  return c.json(await uploadCall(env, "parts", scope))
})

cliRouter.put("/tasks/:id/parts/:number", async c => {
  const { env, scope } = await details(c, true)
  const raw = c.req.param("number") ?? ""
  const number = Number(raw)
  const size = checkedSize(c.req.header("Content-Length") ?? null, S3_CHUNK_SIZE)
  const md5 = c.req.header("x-ol-md5") ?? ""
  if (!/^[1-9]\d{0,4}$/.test(raw) || number > 10000 || !size || !/^[a-f0-9]{32}$/.test(md5) || !c.req.raw.body) {
    fail("InvalidPart", "Invalid part number, length or checksum", 400)
  }
  return c.json(await uploadCall(env, "part", { ...scope, number, size, checksums: { md5 } }, c.req.raw.body))
})

cliRouter.post("/tasks/:id/complete", async c => {
  const { env, scope } = await details(c, true)
  const { parts, size } = await cliJson(c.req.raw)
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE || !Array.isArray(parts) ||
      parts.length === 0 || parts.length > Math.ceil(MAX_FILE_SIZE / MIN_PART_SIZE)) {
    fail("InvalidManifest", "Invalid part manifest", 400)
  }
  const manifest: Manifest = parts.map((part: any, i: number) => {
    if (part?.partNumber !== i + 1 || typeof part.etag !== "string" || !/^[a-f0-9]{32}$/.test(part.etag)) {
      fail("InvalidManifest", "Parts require consecutive numbers and R2 checksums", 400)
    }
    return { partNumber: part.partNumber, etag: part.etag }
  })
  return c.json(await uploadCall(env, "complete", { ...scope, manifest, expectedSize: size }))
})

cliRouter.post("/tasks/:id/cancel", async c => {
  const { env, scope } = await details(c, true)
  await uploadCall(env, "cli-cancel", scope)
  return c.body(null, 204)
})

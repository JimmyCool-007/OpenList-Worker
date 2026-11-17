import app from "./index"
import { OpenListDB } from "./durable-objects/OpenListDB"
import { S3Uploads } from "./durable-objects/S3Uploads"
import { JOB_ID, uploadCall } from "./internal/s3/protocol"
import type { UploadEnv } from "./internal/s3/protocol"

// Durable Object 类（DB_DRIVER=do 时使用），需在 wrangler.toml 声明
// new_sqlite_classes = ["OpenListDB"] 与对应的 binding。
export { OpenListDB, S3Uploads }

export default {
  fetch: app.fetch,
  async queue(batch: {
    messages: { body: unknown; ack(): void; retry(options: { delaySeconds: number }): void }[]
  }, env: UploadEnv) {
    for (const message of batch.messages) {
      const job = message.body as { version?: unknown; id?: unknown } | null
      if (job?.version !== 1 ||
          typeof job.id !== "string" || !JOB_ID.test(job.id)) {
        console.warn("[s3-upload] ignoring unrecognized queue message")
        message.ack()
        continue
      }
      try {
        await uploadCall(env, "step", { id: job.id })
        message.ack()
      } catch {
        message.retry({ delaySeconds: 30 })
      }
    }
  },
}

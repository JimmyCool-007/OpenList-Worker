import { S3Uploads } from "../../src/backend/durable-objects/S3Uploads"
import { UploadLedger } from "../../src/backend/internal/s3/ledger"
import type { LedgerStorage } from "../../src/backend/internal/s3/ledger"
import { stagedKey } from "../../src/backend/internal/s3/transfer"
import type { UploadEnv } from "../../src/backend/internal/s3/protocol"

// This entry point runs only in the isolated R2 binding regression.
export class TestUploads extends S3Uploads {
  constructor(private readonly fixtureState: { storage: LedgerStorage }, private readonly fixtureEnv: UploadEnv) {
    super(fixtureState, { ...fixtureEnv, UPLOAD_QUEUE: { async send() {} } })
  }

  override async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname !== "/fixture-object" && url.pathname !== "/fixture-fail") return super.fetch(request)
    const ledger = new UploadLedger(this.fixtureState.storage)
    const job = ledger.job(url.searchParams.get("id") ?? "")
    if (!job) return new Response(null, { status: 404 })
    if (url.pathname === "/fixture-object") {
      return Response.json(await this.fixtureEnv.R2.head(stagedKey(job)))
    }
    if (job.state !== "staged") return new Response(null, { status: 409 })
    // Reproduce the data left by a legacy Complete that did not return custom metadata.
    ledger.save({ ...job, etag: undefined, version: undefined, state: "failed" })
    return Response.json({ ok: true })
  }
}

export default {
  fetch(request: Request, env: UploadEnv) {
    const uploads = env.S3_UPLOADS
    return uploads.get(uploads.idFromName("local-r2-test")).fetch(request)
  },
}

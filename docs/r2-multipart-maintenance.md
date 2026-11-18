# R2 multipart maintenance (manual only)

The Cloudflare R2 bucket is `data` (see `wrangler.jsonc`). This workflow **only** lists unfinished multipart uploads and aborts one exact upload when explicitly requested. It does **not** delete completed R2 objects, clear Durable Object reservations, release destination locks, or change Google Drive files.

## Setup

Create a GitHub Environment named `r2-maintenance`. For safety, configure required reviewers and restrict deployment branches to `main` once this PR is merged. Add environment secrets `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (R2 S3 API credentials scoped to the `data` bucket with list and multipart abort permissions). Optionally set environment variable `R2_BUCKET=data`. Do not commit credentials.

## Use

Open Actions → **R2 multipart audit and exact abort** → Run workflow → `scan`. Download the `r2-multipart-scan` artifact, which contains JSON Lines with key, upload_id, initiated UTC timestamp and age_hours. This listing may incur R2 Class A operations; it does not read object bodies.

For a candidate, **first inspect the production S3_UPLOADS Durable Object/coordinator state** and verify the task is failed/cancelled/expired, not uploading, queued, sealing, transferring, or resumable. If the coordinator offers a task-scoped cleanup endpoint, use that instead because it also manages locks and quota. Never infer safety from age alone.

Only after that check, run `abort` with the exact `key`, `upload_id`, and `initiated` from the scan, and `confirm=ABORT_EXACT_UPLOAD`. The script refuses uploads younger than 24 hours and fails closed on mismatch or missing upload. GitHub Environment approval is a second independent safeguard. **This cannot automatically prove a DO task is inactive.**

Use a dedicated, revocable R2 key. After maintenance, remove or rotate the credentials. For already-completed staging objects, use the coordinator's safe task-scoped cleanup mechanism, not this workflow.

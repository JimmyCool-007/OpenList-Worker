# OpenList S3 上传与 Google Drive 转存

S3 endpoint 是 **https://drive.jimmy007.com/s3**。使用 path-style，OpenList 用户根目录为 / 时，S3 bucket drive 映射到 OpenList 的 /drive 挂载。S3 bucket 名称与 R2 bucket data 无关。现有 Google Drive 驱动负责解析凭据与存储配置。任务把真实 Drive 根 ID、父目录 ID 和文件名固定下来，转存期间会复检用户权限，清理前复检挂载及父目录。

Rclone 的上传成功表示文件已经完整暂存在 R2。等待任务状态变成 done 后，Drive 文件才进入可下载状态。暂存期间 HEAD 会向同一上传者报告已暂存文件的大小及 ETag。列表与下载继续通过 OpenList 的现有 Drive 路径，原有 WebDAV 地址、认证与传输方式不变。

暂存上传支持新文件。若目标有同名文件、快捷方式或文件夹，会拒绝创建或保留已暂存数据等待处理。上传到子目录前先在 OpenList 建好目录。后台任务需要在不传目录密码的情况下访问目标。可以使用可访问该路径的专用 OpenList 用户。旧客户端的 JWT 普通 PUT 仍适用原有上限和驱动行为。Multipart 支持 JWT 或 SigV4。SigV4 普通 PUT 与 Multipart 一起走暂存配额。

## 部署

1. 在独立测试 Worker 使用测试 KV、测试 R2、测试 Queue 和测试 Google Drive 目录先验证。测试 Worker 的 Queue 名称须和对应配置及 Worker 消费者的队列配置一致。请勿让测试消费者接入生产 Queue。
2. 确认生产 Worker 的绑定与现有配置一致。保留 KV → KV1，核对 Wrangler 中的 KV ID，保留 R2 → data 与 UPLOAD_QUEUE → openlist-upload-queue。把 Dashboard 中额外的绑定、已有迁移和线上 DB 设置同步至实际使用的 Wrangler 配置。保留 keep_vars，核对与 Wrangler vars 同名的生产值。确认已有 custom domain drive.jimmy007.com 仍指向 openlist-worker。
3. SQLite Durable Object 类 S3Uploads、绑定 S3_UPLOADS、迁移 s3-uploads-v1 和 Queue Consumer 由 Wrangler 配置在同一个 Worker 部署。无需创建 D1、新 R2 或新队列。先查看 Dashboard 上已有消费者与迁移记录。如果生产此前有其他迁移，请在当前迁移记录末尾追加此迁移并保留现有绑定。
4. 在 Bucket data 为前缀 __openlist_s3_staging/v1/ 配置仅取消未完成 Multipart Upload 的生命周期规则，年龄 1 天（86400 秒）。保留已有生命周期规则。该前缀由 Worker 独占，避免其他上传或删除工具访问，也不要设置整对象删除规则。上线前检查已有外部 Multipart；能停写时暂停直接上传，否则设置 S3_EXTERNAL_MULTIPART_BYTES 为外部未完成分片总字节数的保守估算，并保持更新。
5. 在 OpenList 中确认 /drive 是启用的 Google Drive 驱动，root_folder_id 指向预期目录，Drive OAuth 可以创建文件。保留现有的 refresh_token 和 OAuth 模式。在 Google Drive 用同一挂载账户确认能够写入/列出测试子目录。为 S3 建专用 OpenList 用户，授予 WRITE_CONTENT 和所需目录访问权限，查出用户 ID（例如该用户登录后查询 /api/me 的 data.id）。以本例的 bucket 名称使用时，用户根目录设为 /。如想限制访问范围，可用现有 OpenList 目录 meta 和用户根机制，并相应调整客户端 bucket 名称。JWT_SECRET 和 Drive 凭据继续沿用现有设置。
6. 通过 Dashboard 保存 S3_ACCESS_KEY_ID 和高熵随机 S3_SECRET_ACCESS_KEY 为 Worker Secrets，S3_USER_ID 为已有用户的数字 ID 字符串。两项 S3 secrets 只用于本网关，不应复用 R2 S3 Access Key。确保 Git 自动生产部署仅从批准的生产分支执行，或把部署步骤设为人工审批。
7. 在批准部署前执行以下检查。完成测试后再部署。生产确认绑定及 consumer 后，在 Dashboard 设普通变量 S3_UPLOAD_MODE=enabled。变量留空时原网关认证行为仍可使用，新的暂存上传还未启用。

~~~sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm exec tsx --test src/backend/internal/s3/uploads.test.ts
pnpm exec tsx --test src/backend/server/webdav_get_sign.test.ts src/backend/server/webdav_propfind.test.ts
pnpm build
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
# 经批准并完成配置核对后执行
pnpm exec wrangler deploy
~~~

现有生产 Queue 名称在 Wrangler 配置中指定。测试 Worker 使用不同 Queue 名称时也只投递版本为 1、包含任务 UUID 的消息，同一 Worker 的队列处理逻辑与测试队列绑定会自动接收。

## Rclone

使用支持这些 S3 选项的当前 Rclone。在 rclone.conf 中将两个占位值替换为 Worker secrets 所用值。保护本机配置文件。Rclone 的 S3 客户端用 SigV4，旧有 JWT 无须填进 Rclone。

~~~ini
[openlist-s3]
type = s3
provider = Other
env_auth = false
access_key_id = YOUR_OPENLIST_S3_ACCESS_KEY_ID
secret_access_key = YOUR_OPENLIST_S3_SECRET_ACCESS_KEY
region = us-east-1
endpoint = https://drive.jimmy007.com/s3
force_path_style = true
no_check_bucket = true
list_version = 2
upload_cutoff = 50M
chunk_size = 50M
upload_concurrency = 4
use_unsigned_payload = true
use_data_integrity_protections = false
use_multipart_etag = false
~~~

use_multipart_etag=false 避免在暂存完成与转存完成之间，把 R2 分片 ETag 误与 Drive 文件 MD5 比较。网关每片仍校验签名携带的 SHA-256 或 Content-MD5，并在 Rclone 提供全文件 MD5 时对照 Drive 校验。

~~~sh
truncate -s 300M openlist-300MiB.bin
truncate -s 2G openlist-2GiB.bin
rclone copy openlist-300MiB.bin openlist-s3:drive/ --s3-upload-cutoff 50M --s3-chunk-size 50M --s3-upload-concurrency 4 -P
rclone copy openlist-2GiB.bin openlist-s3:drive/ --s3-upload-cutoff 50M --s3-chunk-size 50M --s3-upload-concurrency 4 -P
~~~

使用新文件名进行每次验证。Windows PowerShell 可用以下命令生成等大的测试文件。

~~~powershell
$f = [IO.File]::Create("openlist-300MiB.bin")
try { $f.SetLength(300MB) } finally { $f.Dispose() }
$f = [IO.File]::Create("openlist-2GiB.bin")
try { $f.SetLength(2GB) } finally { $f.Dispose() }
~~~

可执行的测试 Worker 集成测试用新文件名上传 300 MiB，共六个 50 MiB 分片。它会检查并发、重传、重复 Complete，取消另一笔测试上传，并等待 Drive 校验和 R2 清理。测试完成后会保留 Drive 文件。`OPENLIST_TEST_S3_BUCKET` 默认为 `drive`，也可以指定 S3 用户实际可见的测试目录。

~~~sh
export OPENLIST_TEST_S3_ENDPOINT=https://your-staging-worker.example/s3
export OPENLIST_TEST_S3_KEY=your-staging-key-id
export OPENLIST_TEST_S3_SECRET=your-staging-secret
pnpm exec tsx scripts/test-s3-gateway.mts
~~~

自动化测试使用内存 SQLite、模拟 R2 / Queue / Drive。覆盖 300 MiB、1 GiB、2 GiB、5 GB 和 9 GB 边界，实际流式传入 50 MiB，检查并发、取消、重传、幂等、Queue 断流、Drive 已收数据但响应丢失和校验失败保留暂存。使用测试 Worker 跑以上集成测试，再用 Rclone 向专用目录实传 300 MiB 和 2 GiB。需要实测 >5 GB 时，在测试账户用 truncate -s 5000000001 生成专用文件并用同一命令上传；通常会在跨过上限的分片收到 EntityTooLarge。需要实测 9 GB 拒绝时，最好在隔离 bucket 给 S3_EXTERNAL_MULTIPART_BYTES 配置模拟基线 8947571200，同时上传两笔 50 MiB 分片，第一笔可以预留，另一笔应收到 503。这个测试不需要真的写满 9 GB。测试后还原外部预留变量。

## 状态、验证和恢复

在以下命令中使用上传者的 OpenList JWT（有目录访问权限），也可以用相同网关用户的 SigV4 签名。路径中的文件名须逐段 URL 编码。Status 也可查指定历史任务，传 &uploadId=UUID。已完成或取消的 HTTP 任务状态保留 7 天。管理员可查询 GET /s3?openlist-quota，查看已审计的外部对象字节数、外部未完成分片预留和暂存预留。

~~~sh
export OPENLIST_URL=https://drive.jimmy007.com
curl -fsS -H "Authorization: Bearer $OPENLIST_JWT" "$OPENLIST_URL/s3/drive/openlist-300MiB.bin?openlist-status"
curl -fsS -H "Authorization: Bearer $OPENLIST_ADMIN_JWT" "$OPENLIST_URL/s3?openlist-quota"
~~~

核对状态 done、offset 与 size 相等、bytes=0、存在 driveId。到 Drive 中按 ID 查看目标文件与大小，在 R2 Dashboard 按 __openlist_s3_staging/v1/UUID 精确查找，成功任务的暂存对象应已删除。使用下列命令对比 WebDAV 下载的大小与 SHA-256。使用测试用户的验证密码。

~~~sh
curl -fsS --user "$OPENLIST_DAV_USER:$OPENLIST_DAV_PASS" -L \
  "$OPENLIST_URL/dav/drive/openlist-300MiB.bin" -o openlist-300MiB.download.bin
sha256sum openlist-300MiB.bin openlist-300MiB.download.bin
~~~

Drive 返回 308 时记录确认位置。响应丢失则重新查询当前偏移，会话过期后用同一预生成的文件 ID 重开，会话完成则查询 Drive 文件验证归属、目录、大小和可用的全文件 MD5。队列重投和后台调度会继续同一任务。失败自动退避，连续失败十次后状态为 failed，R2 对象及其预留会保留，目标锁会释放。重试原任务会先重新获取目标锁。如果同一目标已由新任务占用，原任务的重试会返回 409。

~~~sh
curl -fsS -X POST -H "Authorization: Bearer $OPENLIST_JWT" \
  "$OPENLIST_URL/s3/drive/openlist-300MiB.bin?openlist-retry&uploadId=$UPLOAD_ID"
~~~

如果确认单个失败任务的数据可丢弃，可使用 OpenList 管理员 JWT 释放其预留。清理接口只接受一个任务 ID，在 R2 对象仍在时核验其归属、大小及已记录的版本，删除后再次发 HEAD 检查；成功返回 `state=aborted` 和 `bytes=0`。已清理的请求可重放。对象身份无法核对时返回 409 并保留数据。此操作只涉及该任务的暂存对象和 Durable Object 记录，Google Drive 文件继续保留。

~~~sh
curl -fsS -X POST -H "Authorization: Bearer $OPENLIST_ADMIN_JWT" \
  "$OPENLIST_URL/s3?openlist-discard&uploadId=$UPLOAD_ID"
~~~

本地运行 `node --import tsx scripts/test-s3-r2-binding.mts`，可在隔离的 Cloudflare 本地运行时验证 Multipart、R2 HEAD、旧失败记录、清理和容量释放。

客户端如发生网络中断，可用相同 UploadId 的 ListParts 核对已保存分片，重传缺失分片，再用同一清单重试 Complete。Rclone 进程重启后的新命令可能创建新的 UploadId。旧任务会按 24 小时规则处理，也可用原 UploadId 主动取消。

若检测到 R2 数据版本改变或 Drive 文件冲突，先对照任务 ID 与 Drive 文件归属，保留 R2 副本，在确认后再修正目标或手工恢复。失败任务不会自动删除整对象。24 小时定时清理仅取消未完成的上传。回滚时先把 S3_UPLOAD_MODE 改为 drain。此模式暂停新上传，已有上传可完成、取消和转存。确认所有任务完成，或已独立保存失败任务的 R2 对象与 Drive 目标对应关系后，才切回旧 Worker 版本。保留 S3_UPLOADS 和迁移记录，暂存文件仍有待转存时保留消费者。不要重置该 Durable Object，或对前缀启用整对象过期规则。

## 容量与计费

- 上限使用十进制，单文件 5,000,000,000 字节，bucket 已有对象加受控暂存预留合计 9,000,000,000 字节。默认上传分片是 52,428,800 字节，支持较小的均匀分片，最后一片可更小。R2 要求非尾片至少 5 MiB 且尺寸相同。标准 CreateMultipartUpload 不传文件总大小，因此超大文件可能收到若干成功分片后才被拒绝。
- SQLite Durable Object 在接收 R2 写操作前原子预留已写分片、并行分片及重传分片的字节。成功替换时释放前一个版本的预留。完成后计入已合并对象，验证并删除时释放。外部完整对象通过 R2 目录分页审计纳入预算。只有可核对到任务、版本与字节预留的对象避免重复计数。首次或审计过期时暂停接收预留，等待目录审计完成。
- R2 Binding 不能枚举外部未完成的 Multipart Upload。其他 Worker、R2 官方 S3 Endpoint、控制台或其他直写入口也不会经过本协调器，审计两次之间对外部对象的变化会滞后。尽量专用 bucket 或停用其他写入。已有外部未完成分片须由运营方额外预留。
- 9 GB 是网关的字节预算。Cloudflare 另计账户的 GB-month、Class A/B 请求、其他 bucket、存储类型，以及适用的 Workers、Durable Objects 和 Queues 用量。费用与账单上限请以 Cloudflare 账单和使用情况为准。

参考资料：[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[R2 定价](https://developers.cloudflare.com/r2/pricing/)、[Queues 配置](https://developers.cloudflare.com/queues/configuration/configure-queues/)、[Drive Resumable Upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads)、[Rclone S3](https://rclone.org/s3/)。

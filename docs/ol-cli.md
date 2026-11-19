# OpenList CLI 使用与部署

## 安装

在 Linux AMD64 或 ARM64 上，通过自己的 OpenList-Worker 域名安装：

~~~bash
curl -fsSL https://drive.jimmy007.com/i | bash
export PATH="$HOME/.local/bin:$PATH"
ol version
~~~

`/i` 和 `/install.sh` 由 Worker 直接返回同一份 Bash 脚本，不重定向到 GitHub。脚本只从 `https://drive.jimmy007.com/cli-releases/` 获取最新版本、对应架构二进制和 SHA256SUMS，校验 SHA-256 后才安装。支持 Linux x86_64/AMD64 和 aarch64/ARM64。需要 Bash、curl、sha256sum 和常见系统工具。

安装会将 PATH 行写入 `~/.bashrc` 和 `~/.zshrc`，重复运行不会重复添加。当前终端不会因子进程自动修改 PATH，可执行上面的 `export` 或重新打开终端。再次运行安装命令可安全更新；若已有文件不是此安装器管理的文件，脚本会停止并要求手动处理。可用 `OL_VERSION=0.1.9 bash install-cli.sh` 安装指定已发布版本。

GitHub Releases 仍保留相同的 Linux 二进制和 SHA256SUMS 作为备用渠道：当自有域名不可用时，可手动从对应 Release 下载所需架构并验证 SHA256SUMS。默认脚本不访问 GitHub。

## 登录和会话

~~~bash
ol login
ol whoami
ol logout
~~~

默认服务是 https://drive.jimmy007.com。自托管 Worker 可在首次登录时指定 HTTPS 域名，例如 ol login --server https://drive.example.com。终端隐藏密码和一次性验证码。服务端从签发时起计算 30 × 24 小时的会话有效期。每次登录使用独立随机令牌。Linux 将会话文件保存为 $XDG_CONFIG_HOME/ol/session.json 或 ~/.config/ol/session.json，权限为 0600。

用 ol logout 撤销该会话，随后删除本地凭证。若网络未确认撤销，命令保留本地文件供重试。管理员可用现有 OpenList 管理员 JWT 向 POST /api/cli/v1/admin/revoke 提交 {"userId": 7}，其中 userId 是 OpenList 用户 ID。此操作撤销该用户的当前 CLI 会话。会话状态在 SQLite Durable Object 内读取和撤销。用户权限按当前 OpenList 记录、挂载和目录 ACL 检查。使用现有 KV 用户数据库的部署，其账号与权限更改的可见时间继承 KV 的一致性行为。

## 上传

~~~bash
ol upload dataset.zip
ol upload ./dataset/ --to datasets/ --concurrency 4
ol upload dataset.zip --to datasets/run-01.zip --part-size 25MiB
ol status
ol status <task-id>
ol cancel <task-id>
~~~

远程路径相对于 /drive，受限账号以其获准访问的 Drive 子目录为根。带末尾斜杠的 --to 是目标父目录，否则它是准确的目标路径。递归上传保留相对目录，包括空目录。并发范围为 1–8，默认 4。分片大小支持 5–75 MiB，默认 75 MiB（78,643,200 字节，约 78.6 MB）。旧版本创建的 50 MiB 分片任务和本地断点记录仍可续传。单文件上限为 5,000,000,000 字节。现有 R2 账本管理整个 Bucket 的 9,500,000,000 字节暂存额度。

中断后在同一服务器上重跑原命令。客户端重新计算本地内容哈希，再复用任务清单中大小和 R2 校验值匹配的分片。现有目标只有在 Drive 校验值与本地内容匹配后才会跳过。同名冲突会停止。会话续签后仍可恢复同一用户的本地任务。

R2 上传完成后，由 Worker Queue 继续转存，即使 SSH 关闭也会继续。任务状态区分 R2 上传、排队、Drive 转存、Drive 验证、R2 清理和失败。命令成功退出表示 Drive 已验证且 R2 已清理，或现有文件已通过校验。取消只允许安全的未提交任务或明确无 Drive 提交的失败任务。进入提交或 Drive 转存后，请用状态命令查看进度。服务端历史任务遵循现有账本保留策略，完成和已取消任务通常保留 7 天。

## 传输进度显示

在 SSH 交互终端中，`ol download` 使用**黑白两行内容的简洁边框表格**：第一行显示下载文件名及大小，第二行显示进度条、百分比、速度和 ETA；刷新时原地重绘，不重复刷屏，文件完整性校验成功后原位置显示完成状态、耗时和平均速度。终端宽度不足 32 列时自动退回原有单行显示。`ol upload` 保持原有单行进度条，显示百分比、当前字节数、速度及预计剩余时间。R2 分片上传与 Google Drive 后台转存分别显示独立进度；Google Drive 进度以 Worker 实际报告的已转存字节数为准，并非 R2 上传进度的延续。

Multipart 最终提交、等待后台队列及 R2 清理等阶段无法可靠计算百分比，因此显示动态等待指示而不虚构百分比。只有 Google Drive 验证成功且 R2 清理完成，才会报告任务成功。

SSH 交互终端（包括 AutoDL 上的 MobaXterm）会通过终端实际列数动态缩短文件名及进度条，在较窄的窗口按空间折叠部分统计信息，并预留末尾两列以避免自动换行；调整窗口大小后会在下一次刷新时重新适配。

在输出被重定向到日志文件、容器无交互终端或 `TERM=dumb` 时，进度改为定期输出普通文本日志，不使用终端控制字符。

## OpenList 首页的 R2 暂存容量

登录 OpenList **管理员账号**并访问网盘首页（`/`），在 `Home` 面包屑导航上方显示「R2 暂存剩余」卡片：剩余 GB、9.5 GB 网关预算、已使用/已预留，以及剩余容量进度条，页面可见时每分钟刷新。普通用户、未登录用户不会看到卡片。

数据来自现有管理员专用的 `GET /s3/?openlist-quota` 接口：`9,500,000,000 - reserved - externalObjects - externalMultipart - releaseReserve`（不足零按零显示）。未完成首次 R2 对象审计时显示「容量统计中」，不虚构剩余空间。它反映 Worker 的 **9.5 GB 暂存预算**，不是 Cloudflare 账号所有 R2 bucket 的实际可用/剩余额度。网页 UI 不会暴露管理员 JWT；浏览器仅将现有 OpenList 登录凭证发送到同源的管理员接口。`cli-releases/` 在 Bucket 清单中按实际大小计入 externalObjects；为了在两次审计之间保护直接发布的文件，还预留该前缀总量上限 256 MiB 中尚未审计的部分作为 releaseReserve。已审计的发布资产不会重复计数，因此发布资产和保留量合计至少为 256 MiB。

## 下载

~~~bash
ol ls
ol ls datasets/
ol download dataset.zip --to /data/
ol download datasets/dataset/ --to /data/ --concurrency 4
~~~

下载先写入目标目录内的隐藏临时文件。**单个大文件默认最多使用 4 路并行 Range 下载**（每段 75 MiB，按最多 4 段一批并行获取，再按顺序追加到临时文件）；`--concurrency 1` 可强制单连接，`--concurrency 2`～`8` 可调整连接数。下载文件夹也共用同一个并发请求上限，不会对每个文件各开 4 路导致连接数失控。小文件继续使用单连接；旧 Worker 或上游不支持有界 Range 时自动回退单连接。默认 4 路下载时，临时内存缓冲区最多约 300 MiB；手动设为 8 路时最多约 600 MiB，低内存 VPS 可通过 `--concurrency 1` 或 `--concurrency 2` 降低占用。再次运行时，客户端从已提交的连续文件前缀继续，不依赖不完整的分片状态文件。客户端核对返回的范围和完整长度，并在 Drive 提供时验证 SHA-256 或 MD5。验证后才发布目标文件。已有同名本地文件只有在校验匹配时才会跳过。下载目录需要支持硬链接，以便发布完整文件时安全保留已有目标。支持 Google Drive 普通文件，Drive 原生文档和快捷方式需先导出或下载目标文件。受 OpenList 路径规范限制，含编码转义样式、连续三个点、反斜杠或控制字符的名称无法传输。

## Worker 部署

以下部署步骤面向本仓库的 Cloudflare Worker。wrangler.jsonc 新增 CLI_STATE SQLite Durable Object 绑定和 ol-cli-v1 迁移。部署时应保留现有迁移记录、R2、S3_UPLOADS、UPLOAD_QUEUE 和 OpenList 用户数据库。CLI 复用现有 S3_UPLOAD_MODE 配置及上传账本。enabled 允许新任务，drain 保留现有任务的续传与状态查询。CLI 本身无需新增密钥或环境变量。

~~~bash
pnpm install --frozen-lockfile
pnpm build
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler deploy
~~~

部署需要目标 Cloudflare 账号的 Worker 脚本编辑权限及现有绑定资源的访问权限。生产验证请使用独立测试账号和专用目录。上传、下载后用 sha256sum 核对原件和回读文件，再用 ol status 检查 Drive 验证和 R2 清理。使用现有管理界面仅删除本次唯一测试路径。

## 测试与发布

Go 模块只使用标准库，发布使用受支持的 Go 1.27 工具链。

~~~bash
(cd cli && go test -race ./... && go vet ./...)
pnpm exec tsx --test src/backend/server/cli.test.ts src/backend/internal/s3/uploads.test.ts
~~~

GitHub Actions 验证 CLI、Worker、安装和原有 S3/WebDAV 回归。更新 `cli/VERSION` 并合并到 main 会触发发布：GitHub Releases 作为备用；R2 发布任务等待 Worker 已部署且容量预留可用，先向 `data/cli-releases/<版本>/` 写入两个二进制和 SHA256SUMS，逐项从 R2 读回并核对 SHA-256，最后以条件写切换 `cli-releases/latest`。版本化文件不可覆盖，旧版本不能使 latest 倒退；过程失败时不主动删除任何对象。R2 前缀累计不能超过 256 MiB；达到上限须由管理员核对并手动处理旧版本，本流程不会自动删除。

Actions 的 `r2-maintenance` 环境（或仓库级）需要配置 Secrets：

- `CF_ACCOUNT_ID`：Cloudflare 账户 ID。
- `R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY`：R2 S3 API 凭证，权限为 **Object Read & Write**，Bucket 限定为 `data`；不需要 Bucket 管理、删除 Bucket 或 Workers 编辑权限。普通 R2 长期凭证的限制粒度是 Bucket 而不是前缀，应妥善保护这组密钥。

发布程序在受信任的 Actions runner 内用长期凭证签发 15 分钟临时凭证，将实际 S3 调用限制为 `data` 的 `cli-releases/` 前缀以及 `ListObjectsV2`、`GetObject`、`PutObject` 操作，不授予删除操作；不将任何凭证传给安装机器或 Worker。PR 的 `r2-preflight` 测试前缀读取和条件写权限：使用不可能匹配的 ETag，预期 R2 返回 412，故不会改写对象。如果环境启用了审批，必须允许该环境作业运行。若凭证缺失，先在 GitHub Settings → Environments → `r2-maintenance` → Secrets 添加，重新运行失败的检查和发布作业。

Worker 的 Git 集成单独负责部署；手动部署才需要 Cloudflare 的 Workers Scripts 编辑权限和现有资源绑定权限。发布作业不修改 Worker、Bucket 或 Durable Object。Worker 更新后、R2 首次发布完成前，新的安装入口会暂时无法下载；因此应先确认预检通过、容量有余量和部署正常，再合并并观察两个发布作业。如果 R2 发布失败，修复原因后重跑该作业；不要将失败当成发布成功。

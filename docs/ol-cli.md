# OpenList CLI 使用与部署

## 安装

在 Linux AMD64 或 ARM64 上，通过自己的 OpenList-Worker 域名安装：

~~~bash
curl -fsSL https://drive.jimmy007.com/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
ol version
~~~

`/install.sh` 是 Worker 提供的固定重定向入口：HTTP 302 跳转到本仓库 `main/scripts/install-cli.sh`，因此不需要在 Worker 中重复维护安装脚本。curl 的 `-L` 会跟随重定向；安装脚本和发行二进制仍然托管在 GitHub，安装机器需要能够访问 GitHub。

如果自定义域名尚未部署或无法访问，仍可直接运行原始 GitHub 安装地址：

~~~bash
curl -fsSL https://raw.githubusercontent.com/JimmyCool-007/OpenList-Worker/main/scripts/install-cli.sh | bash
~~~

安装脚本从本仓库的 GitHub Release 下载静态二进制和 SHA256SUMS，校验后安装到 ~/.local/bin/ol。需要 Bash、curl 和常见系统工具。若 PATH 缺少 ~/.local/bin，按脚本打印的 export 命令更新当前终端及 shell 启动文件。

需要先检查脚本时，下载正式标签上的脚本再运行。可在 Release 页面核对同一标签的 SHA256SUMS。

~~~bash
curl --proto '=https' --proto-redir '=https' -fLS \
  https://raw.githubusercontent.com/JimmyCool-007/OpenList-Worker/ol-v0.1.2/scripts/install-cli.sh \
  -o install-cli.sh
less install-cli.sh
OL_VERSION=0.1.2 bash install-cli.sh
~~~

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

远程路径相对于 /drive，受限账号以其获准访问的 Drive 子目录为根。带末尾斜杠的 --to 是目标父目录，否则它是准确的目标路径。递归上传保留相对目录，包括空目录。并发范围为 1–8，默认 3。分片大小支持 5–50 MiB，默认 50 MiB。单文件上限为 5,000,000,000 字节。现有 R2 账本管理整个 Bucket 的 9,000,000,000 字节暂存额度。

中断后在同一服务器上重跑原命令。客户端重新计算本地内容哈希，再复用任务清单中大小和 R2 校验值匹配的分片。现有目标只有在 Drive 校验值与本地内容匹配后才会跳过。同名冲突会停止。会话续签后仍可恢复同一用户的本地任务。

R2 上传完成后，由 Worker Queue 继续转存，即使 SSH 关闭也会继续。任务状态区分 R2 上传、排队、Drive 转存、Drive 验证、R2 清理和失败。命令成功退出表示 Drive 已验证且 R2 已清理，或现有文件已通过校验。取消只允许安全的未提交任务或明确无 Drive 提交的失败任务。进入提交或 Drive 转存后，请用状态命令查看进度。服务端历史任务遵循现有账本保留策略，完成和已取消任务通常保留 7 天。

## 传输进度显示

在 SSH 交互终端中，`ol upload` 和 `ol download` 会使用原地刷新的单行进度条，显示百分比、当前字节数、传输速度和预计剩余时间。R2 分片上传与 Google Drive 后台转存分别显示独立进度；Google Drive 进度以 Worker 实际报告的已转存字节数为准，并非 R2 上传进度的延续。

Multipart 最终提交、等待后台队列及 R2 清理等阶段无法可靠计算百分比，因此显示动态等待指示而不虚构百分比。只有 Google Drive 验证成功且 R2 清理完成，才会报告任务成功。

在输出被重定向到日志文件、容器无交互终端或 `TERM=dumb` 时，进度改为定期输出普通文本日志，不使用终端控制字符。

## 下载

~~~bash
ol ls
ol ls datasets/
ol download dataset.zip --to /data/
ol download datasets/dataset/ --to /data/ --concurrency 4
~~~

下载先写入目标目录内的隐藏临时文件。再次运行时，若服务端接受 Range，客户端从已写入的位置继续。客户端核对返回的范围和完整长度，并在 Drive 提供时验证 SHA-256 或 MD5。验证后才发布目标文件。已有同名本地文件只有在校验匹配时才会跳过。下载目录需要支持硬链接，以便发布完整文件时安全保留已有目标。支持 Google Drive 普通文件，Drive 原生文档和快捷方式需先导出或下载目标文件。受 OpenList 路径规范限制，含编码转义样式、连续三个点、反斜杠或控制字符的名称无法传输。

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

GitHub Actions 验证 CLI、Worker 和原有 S3/WebDAV 回归，通过后发布 ol-linux-amd64、ol-linux-arm64 和 SHA256SUMS。更新 cli/VERSION 并合并到 main 会触发新版本发布。已有版本的资产保持原样，更新二进制时使用新的版本号。

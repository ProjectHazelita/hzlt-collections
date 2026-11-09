# hzlt!Collections

自托管的公开作品与文字分享站。产品边界与技术设计见 [总体设计](docs/architecture/overall-design.md)。

## 开发环境

需要 Docker Compose、Node.js 24.21+（24 系列）和 pnpm 12.9.0。应用、数据库和原生图片依赖在容器内运行，不需要在宿主安装 PostgreSQL 或图像编译库。

```sh
pnpm setup:env
docker compose -f compose.dev.yaml up --build -d --wait api worker
curl -f http://127.0.0.1:3000/api/v1/health
```

`setup:env` 排他创建含随机秘密的 `.env`，不会覆盖已有配置；不要提交该文件。首次启动自动创建非超级用户应用数据库并执行版本化迁移，API 与 Worker 等待迁移成功。开发数据库仅绑定 `127.0.0.1:55432`，API 仅绑定 `127.0.0.1:3000`。Fedora/SELinux 的源码绑定使用共享 `z` 标签。

依赖或配置改变后重建镜像；源码通过绑定目录热更新。请勿把宿主的 `node_modules` 挂进容器。

```sh
docker compose -f compose.dev.yaml exec -T api node scripts/smoke-native.mjs
docker compose -f compose.dev.yaml exec -T api pnpm --filter @hcl/contracts --filter @hcl/server --filter @hcl/api --filter @hcl/worker typecheck
```

数据库和私有媒体使用独立命名卷。不要对已有数据运行 `down -v`；停止开发服务使用 `docker compose -f compose.dev.yaml down`。媒体根目录不得作为静态目录公开。

### 代码检查与格式化

使用固定版本的 Biome 检查 TypeScript、React TSX、JavaScript、JSON 与 CSS，并统一格式和 imports。Biome 命令直接在宿主运行，不需要启动 Docker；首次拉取仓库后用 `pnpm install --ignore-scripts` 安装工具即可，应用和原生依赖仍在容器内运行。

```sh
pnpm check         # lint + 格式 + imports 检查，不修改文件
pnpm check:fix     # 格式化、整理 imports，并应用安全修复
pnpm lint          # 仅 lint
pnpm format        # 仅格式化并写入
pnpm format:check  # 仅检查格式，不写入
pnpm typecheck     # 完整 TypeScript 类型检查，仍通过 Docker tools 执行
```

规则在 `biome.json`，采用推荐规则、2 空格缩进、100 字符行宽、JS/TS 单引号；遵循 Git ignore，排除导出设计资产和生成的数据库迁移。不默认应用 `--unsafe` 修复；有意保留的重试依赖、原生 dialog 键盘行为等使用带理由的局部例外。推荐规则中的 warning/info 仍会报告，error 会使检查失败。

VS Code 可安装 **Biome** 扩展（`biomejs.biome`），将其设为默认 formatter 并启用保存时格式化。Biome 不替代 `tsc`，也不替代交互与业务回归。

## 身份与请求安全

开放注册；第一个成功提交注册事务的用户成为唯一 owner，后续注册者为 member。首次注册完成前不要向不可信网络暴露实例。用户名按 NFKC 和小写键去重；密码为 12–128 个字符，不移除空格，以 Argon2id 保存。

`GET /api/v1/auth/session` 返回当前用户和绑定 Session 的 CSRF token。注册、登录、退出及其他写操作必须同时携带精确匹配 `PUBLIC_ORIGIN` 的 `Origin` 与 `X-CSRF-Token`，浏览器须保留 `hzlt.sid` Cookie。服务端 Session 保存在 PostgreSQL，登录重新生成 generation，退出删除记录；CAS 拒绝退出之后的迟到保存。登录绝对有效期默认 7 天，匿名 CSRF Session 为 1 小时，读取不会续期。

HTTPS 部署将 `PUBLIC_ORIGIN` 设为准确的 HTTPS origin，反向代理地址通过 `TRUST_PROXY` 显式列出，不使用 `true` 信任任意代理。注册和登录按 IP 限流，不信任未配置代理传来的客户端地址。

所有登录用户都可在 `/settings/profile` 修改公开昵称、头像和密码；登录用户名创建后不可修改。昵称为 1–32 个字符，与用户名分离，会用于条目、评论和账号菜单的展示。头像使用普通图片上传，处理后通过 `/media/:assetId/avatar` 公开缩略图；头像资产不能同时作为条目附件，更换或移除头像会清理旧资产。修改密码需要验证当前密码，成功后保留当前会话并轮换 CSRF token，其他设备的 Session 立即失效。

```sh
pnpm test:integration
```

集成验收只接受独立的 `hcl_test` 数据库，并会清理该测试库中的应用数据；不会重置正常的 `hcl` 库。认证回归使用真实 PostgreSQL、真实密码运算及本地 HTTP 连接，覆盖并发首任 owner、用户名冲突、旧 Cookie、过期、跨 Origin、CSRF、限流、HTTPS Cookie，以及退出后的迟到 Session 保存。

## 条目与 API

访客可以浏览、搜索、查看详情和公开标签；登录后可以发布和喜欢。作者可以编辑或删除自己的条目，owner 可以删除全站条目，但不能编辑别人的正文。纯文字和图片附文共用十进制字符串编号，不因删除而重排或复用；客户端不要把编号转换为 JavaScript Number。

`POST /api/v1/entries` 要求 UUID `Idempotency-Key`；同一逻辑提交的网络重试复用该 key，内容改变后使用新 key。幂等记录按用户和操作隔离并保留 24 小时；同 key 不同内容返回 409。正文最多 10000 字符、标题最多 200 字符、标签最多 10 个。条目可同时包含最多 20 张图片、5 个文件和 5 个链接；三类附件互相独立计数，图片与文件都来自作者本人已就绪的上传，链接只接受绝对 http(s) 地址。正文、图片、文件与链接至少存在一项；纯文字条目的正文不能为空。编辑时提交完整的 `imageIds`、`fileIds`、`links` 数组即可增删与重排，未提交的字段保持不变；移除的图片和文件在同一事务中撤销关联并排入文件清理。标签按 NFKC 小写去重，NSFW/AI 声明仅由发布者选择。

## 评论

评论公开读取，发表和回复要求登录。`GET /api/v1/entries/:id/comments` 返回顶层评论及其全部后代回复；数据允许任意层级回复，但前端始终只显示一层缩进，并为每条回复标注所回复的作者。`POST /api/v1/entries/:id/comments` 接受 1–1000 字符正文和可选的 `parentId`，父评论必须属于同一条目。删除条目会同时删除其评论。

列表以游标分页，`q` 对标题、正文和标签进行字面量搜索，`%`、`_` 和反斜线不是通配符。喜欢列表只返回当前用户的数据；已删除条目不会出现在列表、搜索、喜欢或管理结果中。已发布条目可增删图片、文件和链接，但每个附件资产只能属于一个未删除条目。

实际路由的 OpenAPI 文档位于 `/api/v1/openapi.json`。统一错误结构为 `{error:{code,message,requestId,fields?}}`，不包含数据库诊断或私有文件路径。`PATCH /api/v1/me/profile` 更新昵称或头像并返回新的 Session；`PUT /api/v1/me/password` 验证当前密码后更新密码、保留当前会话并注销其他设备。

## 私有图片、文件上传与 Worker

登录后向 `POST /api/v1/uploads` 提交仅含一个 `file` 的多部分请求，并可附带一个 `kind` 文本字段：`image`（默认）要求静态 JPEG、PNG、WebP、GIF，`file` 接受任意字节并在发布后作为下载提供。请求同时携带 CSRF、Origin 和 UUID `Idempotency-Key`。API 流式写入私有目录；图片检查真实文件头，文件名、扩展名和声明的 Content-Type 不决定格式。拒绝 SVG、APNG 和其他动画。默认上传上限 20 MiB；图片解码上限 4000 万像素、单边 20000 像素，均由环境变量配置。文件不进行内容转码，也不通过原图地址公开；下载统一使用 `application/octet-stream` 与 `attachment`，原始文件名经过清理并同时提供 UTF-8 编码形式。

上传返回 `202 {id,kind,status:"pending"}`。上传者通过 `GET /api/v1/uploads/:id` 查询 pending / ready / failed 及明确的失败码；其他用户和游客得到 404。相同逻辑上传重试复用幂等 key，换文件使用新 key。上传记录、幂等记录和处理任务在同一数据库事务提交；断连和失败请求的临时文件会清除。

Worker 使用独立 OS 子进程完整解码图片、按 EXIF 方向旋转并生成不超过 768 × 2048 的 WebP 缩略图，不放大、不携带 EXIF。文件资产不启动原生解码子进程，由 Worker 直接标记为 ready。原始文件字节保持不变，**发布原图会一并公开其中可能存在的拍摄位置等元数据**。ready 只表示处理完成，不等于公开；必须关联成功发布的条目，未发布的 ready 文件在 24 小时后过期。

每个 Worker 同时处理一个媒体子进程，父进程施加默认 30 秒硬期限并等待被终止的子进程实际退出；任务中止、子进程崩溃和 Worker 意外退出通过任务租约与重试恢复。派生文件按独立 attempt 命名，过时尝试不能覆盖当前结果。每 5 分钟对账取消/失败任务、过期 Session 与幂等记录、失败/过期未发布资产，并回收超过一小时且数据库无引用的遗留文件；延后排队的有效任务不会因等待较久而被误删。

默认开发和生产 Worker 的容器限制为 1 GiB 内存、2 CPU、64 PID；API 与 Worker 分离。子进程只接收生成路径和限额，环境中不传数据库与 Session 秘密。128 MiB Node heap 和关闭 Sharp cache 不是 native 总内存硬上限，去掉环境变量也不是完整 RCE 沙箱；实际资源上限来自容器。不要将 `DATA_DIR` 挂成静态网站或直接对外公开。

## 已发布媒体与删除

`GET /media/:assetId/original`、`thumbnail`、`download` 每次都确认图片已就绪且关联未删除的条目；未发布、处理中、失败、已删除和缺失文件统一返回 404，不因访问者是上传者或 owner 而放行。存储目录不提供目录浏览或静态访问。

原图保持真实 MIME 并以 inline 返回；下载为 attachment，文件名使用 `entry-<条目编号>.<真实扩展名>`，不信任上传文件名。缩略图为 WebP。三个地址均使用 `X-Content-Type-Options: nosniff` 和 `Cache-Control: no-store`。

删除条目在同一事务中撤销公开关联、清除喜欢并排入文件清理任务；204 返回后所有新媒体请求立即为 404，不等待 Worker 删除磁盘文件。清理可安全重试，缺失文件视为已清理，其他文件系统错误会保留为失败任务。删除不能撤回访问者已经保存的副本或已经开始的传输。

## 浏览器界面

`pnpm dev` 启动 API、Worker 和 Vite；开发界面为 `http://127.0.0.1:5173`，请求由同源开发代理转发至 API。字体与导航标志随应用自托管，不请求外部图库或 Google Fonts。

首页、搜索及喜欢页共用按原始宽高比分配的最短列瀑布流，手机为两列；只有超长图在卡片中截取预览，详情仍展示完整图片。文字与图片共用条目编号和可复制的绝对链接。从列表打开详情保留来源查询、滚动和焦点，直接打开详情也可独立阅读。

发布支持纯文字、图片、文件和链接，也可在同一个条目内组合使用；上限为 20 张图片、5 个文件和 5 个链接。上传后逐项查询实际处理状态，附件就绪后才能提交，失败不会清空正文、标签或已选附件。编辑可任意增删图片、文件和链接，并保留其余内容；已发布附件通过新的 `imageIds`/`fileIds`/`links` 完整列表替换。详情弹层按设计稿展示多图查看、文件下载、链接卡片与单层缩进的评论区；登录用户可发表评论或回复任意一条评论，回复目标以「回复 某人」标注。作者可编辑自己的条目；左下角齿轮进入设置，owner 额外拥有站点管理分区。

桌面端与移动端均使用瀑布流；卡片作者页脚常驻，图片标题与渐变在悬停时淡入，文字卡片底部使用渐进模糊淡出。弹层、评论、附件块、账号菜单与卡片悬停使用短促过渡，并遵守 `prefers-reduced-motion`。

左下角齿轮进入设置，采用左侧分区导航：所有用户可管理个人资料与密码，owner 额外拥有站点管理分区。头像与昵称会同步显示在导航、卡片、详情和评论中；修改密码后其他设备需要重新登录。

客户端将身份版本保存在 ref 中，在读取响应、解析及写入缓存前检查版本；退出或 401 会取消请求并清除含个性化权限与喜欢状态的全部条目缓存。迟到的真实成功响应不能恢复已退出用户的喜欢或管理视图。复制链接优先使用 Clipboard API，HTTP 局域网环境尝试实际的兼容复制，失败则显示可手动选择的完整链接。

开发 Worker 直接使用 Node watch，避免 pnpm/tsx watch 的多层常驻进程；构建器限制 `GOMAXPROCS=2`，以在不放宽 64 PID 限制的前提下为原生媒体子进程留出空间。生产媒体子进程不加载开发构建器，也不接收数据库或 Session 环境变量。

## 生产部署

```sh
pnpm setup:env
PRODUCTION_ORIGIN=http://127.0.0.1:18080 docker compose up --build -d
curl -f http://127.0.0.1:18080/api/v1/health
```

生产镜像使用 Node 24 多阶段构建，API 同时提供编译后的界面、JSON API 与受权限边界控制的媒体；无须另起 Vite、Redis 或 nginx 容器。数据库不发布宿主端口；HTTP 默认仅绑定 `127.0.0.1:18080`，可用 `HTTP_PORT` 调整。migrate 成功后才启动 API/Worker。运行账号为非 root 的 `node`，移除全部 Linux capabilities，不挂 Docker socket；生产 Worker 同样限制为 1 GiB / 2 CPU / 64 PID。

Compose 使用 `PRODUCTION_ORIGIN` 设置容器内的 `PUBLIC_ORIGIN`，默认是上述本地 HTTP origin。公网部署应由已有 TLS 反代提供 HTTPS，将 `PRODUCTION_ORIGIN` 与对外 `PUBLIC_ORIGIN` 都设为同一个准确的 HTTPS origin，并把 `TRUST_PROXY` 设为实际可信代理地址；不能使用 `true` 或依赖任意转发头。变更配置后重新创建容器。不要在首次 owner 注册前向不可信网络开放入口。

界面直达只覆盖 `/`、`/search`、`/likes`、`/publish`、`/login`、`/register`、`/settings/content`、`/entries/:id` 和 `/entries/:id/edit` 的 HTML GET/HEAD 请求。构建资源仅从 web dist 的已知普通文件提供；未知 API、媒体、路径、目录、点文件、源码及路径穿越不会回退为 HTML。HTML 不缓存，带内容哈希的构建资源可长期缓存；原图和缩略图仍逐请求检查发布状态且不缓存。

查看状态与日志：

```sh
docker compose ps
docker compose logs --since 10m api worker migrate
```

### 一致备份与恢复

数据库包含账号、Session、条目和队列；媒体卷包含原图与派生文件。只备份其中一个不能恢复完整站点。备份包含密码哈希、会话和原图元数据，应限制访问并加密保存；另行安全保存 `.env` 中的秘密，不把它放入公开仓库。

在同一个生产项目、同一套 Compose 环境变量下执行；暂停 API/Worker，等待其优雅退出后，再同时备份数据库和媒体，保持两者一致：

```sh
set -eu
umask 077
backup="backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$backup"
docker compose stop api worker
trap 'docker compose start api worker' EXIT
docker compose exec -T db pg_dump -U hcl -d hcl -Fc > "$backup/database.dump"
docker compose run --rm --no-deps --entrypoint tar api \
  -C /var/lib/hcl/media -czf - . > "$backup/media.tar.gz"
docker compose start api worker
trap - EXIT
```

恢复时先使用**新的空项目和空卷**、相同数据库凭据与 Session secret，以及匹配的应用版本；仅启动 db，等其健康后，用 `pg_restore -U hcl -d hcl` 导入数据库，用同一 API 镜像的 `tar -xzf - -C /var/lib/hcl/media` 导入媒体（通过 `docker compose exec -T db` / `docker compose run --rm --no-deps --entrypoint tar api` 传入备份）。然后正常 `docker compose up -d` 执行迁移并启动服务，检查健康、账号、条目及原图哈希后再切流。不要对正在使用的数据库直接覆盖恢复，不要删除旧卷来“修复”启动失败。

## 可重复验收

```sh
pnpm typecheck
pnpm build
pnpm test:integration
```

集成测试使用真实 PostgreSQL、HTTP、队列与原生解码子进程，测试库固定为隔离的 `hcl_test`。生产静态边界也通过真实 HTTP 验证，不以 SPA 兜底隐藏错误。

完整 HTTP smoke 使用另一个空实例和独立运行的 API/Worker。每次选一个新的后缀；下面两条命令必须复用同一次生成的环境：

```sh
export COMPOSE_PROJECT_NAME="hcl-proof-api-$(date -u +%Y%m%d%H%M%S)"
export WEB_PORT=15173 API_HOST_PORT=13000 DEV_DB_PORT=55433
export PUBLIC_ORIGIN=http://127.0.0.1:15173
pnpm dev
pnpm smoke:api
docker compose -f compose.dev.yaml stop
```

端口被其他服务占用时换端口并同步 origin，不终止其他项目。脚本在任何 HTTP 写入前核实项目名前缀、实际数据库名及 users/entries 为空，拒绝非空库，不自动重置。成功时输出 `SMOKE_API_OK`，覆盖真实身份权限、CRUD、字面量搜索、喜欢、五组静态/EXIF 图片、原图 SHA256、缩略图解码、八类失败输入和删除撤销公开访问；Worker 崩溃恢复、硬超时及 Session CAS 竞态由集成测试单独覆盖。浏览器交互、视觉与生产重启持久化仍需在各自隔离实例实际验收。

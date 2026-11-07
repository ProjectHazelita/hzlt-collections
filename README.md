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

## 身份与请求安全

开放注册；第一个成功提交注册事务的用户成为唯一 owner，后续注册者为 member。首次注册完成前不要向不可信网络暴露实例。用户名按 NFKC 和小写键去重；密码为 12–128 个字符，不移除空格，以 Argon2id 保存。

`GET /api/v1/auth/session` 返回当前用户和绑定 Session 的 CSRF token。注册、登录、退出及其他写操作必须同时携带精确匹配 `PUBLIC_ORIGIN` 的 `Origin` 与 `X-CSRF-Token`，浏览器须保留 `hzlt.sid` Cookie。服务端 Session 保存在 PostgreSQL，登录重新生成 generation，退出删除记录；CAS 拒绝退出之后的迟到保存。登录绝对有效期默认 7 天，匿名 CSRF Session 为 1 小时，读取不会续期。

HTTPS 部署将 `PUBLIC_ORIGIN` 设为准确的 HTTPS origin，反向代理地址通过 `TRUST_PROXY` 显式列出，不使用 `true` 信任任意代理。注册和登录按 IP 限流，不信任未配置代理传来的客户端地址。

```sh
pnpm test:integration
```

集成验收只接受独立的 `hcl_test` 数据库，并会清理该测试库中的应用数据；不会重置正常的 `hcl` 库。认证回归使用真实 PostgreSQL、真实密码运算及本地 HTTP 连接，覆盖并发首任 owner、用户名冲突、旧 Cookie、过期、跨 Origin、CSRF、限流、HTTPS Cookie，以及退出后的迟到 Session 保存。

## 条目与 API

访客可以浏览、搜索、查看详情和公开标签；登录后可以发布和喜欢。作者可以编辑或删除自己的条目，owner 可以删除全站条目，但不能编辑别人的正文。纯文字和图片附文共用十进制字符串编号，不因删除而重排或复用；客户端不要把编号转换为 JavaScript Number。

`POST /api/v1/entries` 要求 UUID `Idempotency-Key`；同一逻辑提交的网络重试复用该 key，内容改变后使用新 key。幂等记录按用户和操作隔离并保留 24 小时；同 key 不同内容返回 409。正文最多 10000 字符、标题最多 200 字符、标签最多 10 个。标签按 NFKC 小写去重，NSFW/AI 声明仅由发布者选择。

列表以游标分页，`q` 对标题、正文和标签进行字面量搜索，`%`、`_` 和反斜线不是通配符。喜欢列表只返回当前用户的数据；已删除条目不会出现在列表、搜索、喜欢或管理结果中。已发布条目的图片身份不可修改。

实际路由的 OpenAPI 文档位于 `/api/v1/openapi.json`。统一错误结构为 `{error:{code,message,requestId,fields?}}`，不包含数据库诊断或私有文件路径。

## 私有图片上传与 Worker

登录后向 `POST /api/v1/uploads` 提交仅含一个 `file` 的 multipart 请求，并携带 CSRF、Origin 和 UUID `Idempotency-Key`。API 流式写入私有目录并检查真实文件头；文件名、扩展名和声明的 Content-Type 不决定格式。只接受静态 JPEG、PNG、WebP、GIF，拒绝 SVG、APNG 和其他动画。默认上传上限 20 MiB；解码上限 4000 万像素、单边 20000 像素，均由环境变量配置。

上传返回 `202 {id,status:"pending"}`。上传者通过 `GET /api/v1/uploads/:id` 查询 pending / ready / failed 及明确的失败码；其他用户和游客得到 404。相同逻辑上传重试复用幂等 key，换文件使用新 key。上传记录、幂等记录和处理任务在同一数据库事务提交；断连和失败请求的临时文件会清除。

Worker 使用独立 OS 子进程完整解码、按 EXIF 方向旋转并生成不超过 768 × 2048 的 WebP 缩略图，不放大、不携带 EXIF。原始文件字节保持不变，**发布原图会一并公开其中可能存在的拍摄位置等元数据**。ready 只表示处理完成，不等于公开；必须关联成功发布的条目，未发布的 ready 文件在 24 小时后过期。

每个 Worker 同时处理一个媒体子进程，父进程施加默认 30 秒硬期限并等待被终止的子进程实际退出；任务中止、子进程崩溃和 Worker 意外退出通过任务租约与重试恢复。派生文件按独立 attempt 命名，过时尝试不能覆盖当前结果。每 5 分钟对账取消/失败任务、过期 Session 与幂等记录、失败/过期未发布资产，并回收超过一小时且数据库无引用的遗留文件；延后排队的有效任务不会因等待较久而被误删。

默认开发和生产 Worker 的容器限制为 1 GiB 内存、2 CPU、64 PID；API 与 Worker 分离。子进程只接收生成路径和限额，环境中不传数据库与 Session 秘密。128 MiB Node heap 和关闭 Sharp cache 不是 native 总内存硬上限，去掉环境变量也不是完整 RCE 沙箱；实际资源上限来自容器。不要将 `DATA_DIR` 挂成静态网站或直接对外公开。

## 已发布媒体与删除

`GET /media/:assetId/original`、`thumbnail`、`download` 每次都确认图片已就绪且关联未删除的条目；未发布、处理中、失败、已删除和缺失文件统一返回 404，不因访问者是上传者或 owner 而放行。存储目录不提供目录浏览或静态访问。

原图保持真实 MIME 并以 inline 返回；下载为 attachment，文件名使用 `entry-<条目编号>.<真实扩展名>`，不信任上传文件名。缩略图为 WebP。三个地址均使用 `X-Content-Type-Options: nosniff` 和 `Cache-Control: no-store`。

删除条目在同一事务中撤销公开关联、清除喜欢并排入文件清理任务；204 返回后所有新媒体请求立即为 404，不等待 Worker 删除磁盘文件。清理可安全重试，缺失文件视为已清理，其他文件系统错误会保留为失败任务。删除不能撤回访问者已经保存的副本或已经开始的传输。

## 浏览器界面

`pnpm dev` 启动 API、Worker 和 Vite；开发界面为 `http://127.0.0.1:5173`，请求由同源开发代理转发至 API。字体与导航标志随应用自托管，不请求外部图库或 Google Fonts。

首页、搜索及喜欢页共用按原始宽高比分配的最短列瀑布流，手机为两列；只有超长图在卡片中截取预览，详情仍展示完整图片。文字与图片共用条目编号和可复制的绝对链接。从列表打开详情保留来源查询、滚动和焦点，直接打开详情也可独立阅读。

发布支持纯文字或单张静态图片；上传后每秒查询实际处理状态，图片就绪后才能提交，失败不会清空正文、标签或本地选图。已发布图片不能替换，标签与 NSFW/AI 声明只在发布者选中后显示。作者可编辑自己的条目；owner 的齿轮进入真实内容管理，普通用户齿轮打开账号菜单。

客户端将身份版本保存在 ref 中，在读取响应、解析及写入缓存前检查版本；退出或 401 会取消请求并清除含个性化权限与喜欢状态的全部条目缓存。迟到的真实成功响应不能恢复已退出用户的喜欢或管理视图。复制链接优先使用 Clipboard API，HTTP 局域网环境尝试实际的兼容复制，失败则显示可手动选择的完整链接。

开发 Worker 直接使用 Node watch，避免 pnpm/tsx watch 的多层常驻进程；构建器限制 `GOMAXPROCS=2`，以在不放宽 64 PID 限制的前提下为原生媒体子进程留出空间。生产媒体子进程不加载开发构建器，也不接收数据库或 Session 环境变量。

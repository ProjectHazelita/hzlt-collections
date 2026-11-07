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

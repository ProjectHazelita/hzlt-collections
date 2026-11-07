# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/opt/corepack
ENV XDG_DATA_HOME=/pnpm/data
ENV XDG_CACHE_HOME=/pnpm/cache
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.9.0 --activate

FROM base AS development
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile \
    && mkdir -p /var/lib/hcl/media \
    && chown -R node:node /app /pnpm /opt/corepack /var/lib/hcl/media
COPY --chown=node:node . .
USER node
RUN pnpm --version

FROM development AS build
RUN pnpm build:packages \
    && pnpm --filter=@hcl/api --prod deploy /app/out/api \
    && pnpm --filter=@hcl/worker --prod deploy /app/out/worker

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/hcl/media && chown node:node /var/lib/hcl/media
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /app/out/api /app/apps/api
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
COPY --from=build --chown=node:node /app/packages/server/drizzle /app/packages/server/drizzle
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /app/out/worker /app/apps/worker
CMD ["node", "apps/worker/dist/main.js"]

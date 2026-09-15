ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
# pnpm-lock.yaml PHẢI có trong repo: --frozen-lockfile fail nếu thiếu hoặc lệch.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @engram/web build

FROM ${NODE_IMAGE}
WORKDIR /app
RUN corepack enable
COPY --from=build /src ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@engram/web", "start"]

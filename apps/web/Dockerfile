ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ARG API_UPSTREAM=http://127.0.0.1:8080
ENV API_UPSTREAM=${API_UPSTREAM}
ARG NEXT_PUBLIC_CONTENT_ENABLED=false
ENV NEXT_PUBLIC_CONTENT_ENABLED=${NEXT_PUBLIC_CONTENT_ENABLED}
RUN corepack enable
# pnpm-lock.yaml PHẢI có trong repo: --frozen-lockfile fail nếu thiếu hoặc lệch.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @engram/web build

FROM ${NODE_IMAGE}
WORKDIR /app
ARG API_UPSTREAM=http://127.0.0.1:8080
ENV API_UPSTREAM=${API_UPSTREAM}
ARG NEXT_PUBLIC_CONTENT_ENABLED=false
ENV NEXT_PUBLIC_CONTENT_ENABLED=${NEXT_PUBLIC_CONTENT_ENABLED}
RUN corepack enable
COPY --from=build /src ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@engram/web", "start"]

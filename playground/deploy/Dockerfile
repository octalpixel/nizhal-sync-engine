# Container image for the Nizhal sync server — deployable to Docker, Fly.io, Railway, Render, AWS
# (ECS/Fargate/App Runner), SST, or any container host. It's a long-running Node process, so realtime
# WebSockets and listenNotifyRealtime's persistent LISTEN work as-is.
#
# Build from the REPO ROOT (the monorepo is the build context):
#   docker build -f playground/deploy/Dockerfile -t nizhal-server .
#   docker run -p 4700:4700 -e DATABASE_URL=postgres://... -e JWT_SECRET=... nizhal-server
#
# DATABASE_URL must be a DIRECT (session-mode) Postgres connection so listenNotifyRealtime's LISTEN
# survives (a transaction-mode pooler like Neon's pooled endpoint breaks it).
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @nizhal/kernel --filter @nizhal/server --filter @nizhal/local build

FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
ENV PORT=4700
EXPOSE 4700
CMD ["pnpm", "--filter", "nizhal-deploy", "start"]

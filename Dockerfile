# sdlc-code in one container: the server and the dashboard it serves (S2).
#
#   docker build -t sdlc-code .
#   docker run -p 4317:4317 -v sdlc-data:/data \
#     -e SDLC_ACCESS_TOKEN=... -e NEBIUS_API_KEY=... -e NEBIUS_AI_PROJECT=... \
#     -e PENPOT_MCP_URL=... -e GITHUB_TOKEN=... sdlc-code
#
# Secrets come from the environment at run time and are never in the image
# (.dockerignore keeps every .env file out). The server refuses to start on the
# network without SDLC_ACCESS_TOKEN. Runs are kept in the /data volume.

FROM node:22-bookworm-slim AS build
# git: the Workspaces of a Run are git worktrees. corepack: the pnpm the repo pins.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @sdlc-code/web build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && useradd --create-home --uid 10001 sdlc \
 && mkdir /data && chown sdlc /data
WORKDIR /app
COPY --from=build --chown=sdlc /app /app
USER sdlc
# git needs an identity to commit a Slice, and a home to keep it in.
RUN git config --global user.name "sdlc-code" \
 && git config --global user.email "sdlc-code@users.noreply.github.com"

ENV NODE_ENV=production \
    SDLC_CODE_HOST=0.0.0.0 \
    SDLC_CODE_PORT=4317 \
    SDLC_DATA_DIR=/data \
    SDLC_WEB_DIR=/app/apps/web/dist
VOLUME /data
EXPOSE 4317
# Any answer means it is up: /health says 503 for a missing key, not for a dead server.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.SDLC_CODE_PORT+'/api/health').then(()=>process.exit(0),()=>process.exit(1))"
WORKDIR /app/apps/server
CMD ["node", "--import", "@swc-node/register/esm-register", "src/main.ts"]

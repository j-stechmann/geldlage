# syntax=docker/dockerfile:1

# --- Build stage -------------------------------------------------------------
# node:24 glibc (Active LTS) base; better-sqlite3 v13 ships NAPI prebuilds that
# are ABI-stable across node majors - glibc (bookworm) is what must match.
# Pinned to 24.22.1: first 24.x with the Brotli decoder OOB-write fix
# (CVE-2026-111497, Node.js security releases 2026-10-21).
FROM node:24.22.1-bookworm-slim AS builder

COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Lockfile-first for layer caching. --ignore-scripts skips the implicit
# `node-gyp rebuild` that bun runs for packages containing binding.gyp
# (better-sqlite3); its prebuilt NAPI binary ships in the tarball and is
# what the runtime loader picks up, so no python/make/g++ toolchain needed.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
RUN bun run build

# Fail fast if the native prebuild was not traced into the standalone output
RUN test -f .next/standalone/node_modules/better-sqlite3/prebuilds/linux-x64.node

# --- Runtime stage -----------------------------------------------------------
FROM node:24.22.1-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/app/data/geldlage.db

WORKDIR /app

# Standalone output contains server.js + pruned node_modules (incl. instrumentation)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Single runtime write target (SQLite db + WAL/shm, auto-created schema)
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

# HTTP liveness probe only: this route always returns 200 (LLM status
# is in the body, DB status is not checked), so an external llama-server
# outage or a misconfigured DATABASE_PATH never marks the container unhealthy.
# Schema setup in instrumentation only logs failures instead of crashing
# startup, so DB readiness is not covered by probes or --start-period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/llm/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

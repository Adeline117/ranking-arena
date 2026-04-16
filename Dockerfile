# ─────────────────────────────────────────────────────────────
# Ranking Arena Worker Service (DEPRECATED — retained for history)
#
# Build context: repository root
# Last updated: 2026-04-16
#
# STATUS: The standalone worker service was removed from this repo in
# commits a199f5353 ("clean up repo structure — remove 170 dead files")
# and b155a9669. The `worker/` directory now only contains `.env` and no
# longer ships source code or package.json. Building this image in its
# current form will fail at `npm ci` inside /app/worker.
#
# Background jobs are now executed via:
#   - Vercel Cron (see vercel.json)
#   - Trigger.dev (see trigger.config.ts, lib/jobs/)
#   - OpenClaw autonomous ops on Mac Mini (scripts/openclaw/)
#
# This file is retained only as a reference for re-introducing a
# containerized worker. Do not wire this into CI/CD until the worker
# source tree is restored (needs: worker/package.json, worker/src/
# index.ts, worker/tsconfig.json).
#
# VERIFIED PATHS (as of 2026-04-16):
#   lib/cron/fetchers/  EXISTS (37 fetcher modules)
#   worker/             EXISTS but is effectively empty
#   worker/src/index.ts MISSING
#   worker/package.json MISSING
# ─────────────────────────────────────────────────────────────

FROM node:20-slim

# Install dependencies required for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy shared fetchers (verified to exist — used if worker is ever restored)
COPY lib/cron/fetchers/ /app/lib/cron/fetchers/
# Copy shared connectors (authoritative platform adapters)
COPY lib/connectors/ /app/lib/connectors/

# NOTE: Everything below this line requires the worker source tree to be
# restored under `worker/` (worker/package.json + worker/src/index.ts).
# Until then these steps will fail.

# Copy entire worker directory (currently only contains .env)
COPY worker/ /app/worker/

# Install dependencies (fails until worker/package.json is restored)
RUN cd /app/worker && npm ci && npm cache clean --force

# Install Playwright browsers (chromium only to reduce size)
RUN cd /app/worker && npx playwright install chromium

# Environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s CMD node -e "process.exit(0)"

# Run from worker directory (fails until worker/src/index.ts is restored)
WORKDIR /app/worker
CMD ["npx", "tsx", "src/index.ts"]

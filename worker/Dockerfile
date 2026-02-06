# Ranking Arena Worker Service
# Build context: repository root (see railway.json buildContextPath)
# Last updated: 2026-02-06

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

# Copy shared lib first (required by worker imports)
COPY lib/cron/fetchers/ /app/lib/cron/fetchers/

# Copy entire worker directory
COPY worker/ /app/worker/

# Install dependencies
RUN cd /app/worker && npm ci && npm cache clean --force

# Install Playwright browsers (chromium only to reduce size)
RUN cd /app/worker && npx playwright install chromium

# Environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s CMD node -e "process.exit(0)"

# Run from worker directory
WORKDIR /app/worker
CMD ["npx", "tsx", "src/index.ts"]

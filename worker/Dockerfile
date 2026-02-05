# Ranking Arena Worker Service
# Build context: repository root

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

# Copy worker package.json and install dependencies
COPY worker/package*.json ./worker/
RUN cd worker && npm ci && npm cache clean --force

# Install Playwright browsers (chromium only to reduce size)
RUN cd worker && npx playwright install chromium

# Copy shared lib (required by worker imports: ../../../lib/cron/fetchers)
COPY lib/cron/fetchers/ ./lib/cron/fetchers/

# Copy worker source and config
COPY worker/src/ ./worker/src/
COPY worker/tsconfig.json ./worker/

# Environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s CMD node -e "process.exit(0)"

# Run from worker directory
WORKDIR /app/worker
CMD ["npx", "tsx", "src/index.ts"]

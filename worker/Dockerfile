# Ranking Arena Worker Service
# Standalone data fetching service
# Build context: repository root (specified in railway.json)

FROM node:20-alpine AS base

WORKDIR /app

# Copy worker package files and install dependencies
COPY worker/package.json worker/package-lock.json* ./worker/
WORKDIR /app/worker
RUN npm ci --omit=dev && npm install -D tsx typescript @types/node

# Switch back to app root
WORKDIR /app

# Copy shared library files needed by worker
COPY lib/cron/fetchers/ ./lib/cron/fetchers/

# Copy worker source and config
COPY worker/src/ ./worker/src/
COPY worker/tsconfig.json ./worker/

# Environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Run from /app/worker directory where node_modules exists
WORKDIR /app/worker

# Default command: run all enabled platforms
CMD ["npx", "tsx", "src/index.ts"]

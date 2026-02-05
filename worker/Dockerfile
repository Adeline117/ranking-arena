# Ranking Arena Worker Service
# Standalone data fetching service
# Build context: repository root (specified in railway.json)

FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies from worker's package.json
COPY worker/package.json worker/package-lock.json* ./
RUN npm ci --omit=dev

# Copy shared library files needed by worker
COPY lib/cron/fetchers/ ./lib/cron/fetchers/

# Copy worker source files
COPY worker/src/ ./worker/src/
COPY worker/tsconfig.json ./worker/

# Install tsx for TypeScript execution
RUN npm install -D tsx typescript @types/node

# Environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Default command: run all enabled platforms
CMD ["npx", "tsx", "worker/src/index.ts"]

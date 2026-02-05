# Ranking Arena Worker Service
# Build context: repository root

FROM node:20-alpine

WORKDIR /app

# Copy worker package.json and install dependencies
COPY worker/package*.json ./worker/
RUN cd worker && npm ci && npm cache clean --force

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

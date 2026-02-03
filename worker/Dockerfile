# Ranking Arena Worker Service
# Standalone data fetching service

FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Copy source files
COPY lib/cron/fetchers/ ./lib/cron/fetchers/
COPY worker/src/ ./worker/src/
COPY tsconfig.json ./

# Install tsx for TypeScript execution
RUN npm install -D tsx typescript @types/node

# Environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Default command: run all enabled platforms
CMD ["npx", "tsx", "worker/src/index.ts"]

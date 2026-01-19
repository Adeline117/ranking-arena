# Arena Worker Dockerfile
# 用于在 Railway 或其他容器服务上运行爬虫
# 使用多阶段构建优化镜像大小

# ==================== 构建阶段 ====================
FROM node:20-slim AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./
COPY tsconfig.json ./

# 安装所有依赖（包括 devDependencies 用于构建）
RUN npm ci

# 复制源代码
COPY src ./src

# 构建 TypeScript
RUN npm run build

# ==================== 生产阶段 ====================
FROM node:20-slim

# 安装 Playwright 依赖
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 只安装生产依赖
RUN npm ci --only=production

# 安装 Playwright Chromium
RUN npx playwright install chromium

# 从构建阶段复制编译后的代码
COPY --from=builder /app/dist ./dist

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('OK')" || exit 1

# 默认运行全部抓取
CMD ["npm", "run", "start"]

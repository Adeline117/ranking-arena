#!/bin/bash
# VPS-US Setup Script
# Target: Ubuntu 22.04/24.04 (US region, e.g. Vultr LAX/SJC)
# Usage: ssh root@<vps-ip> 'bash -s' < setup.sh

set -euo pipefail

echo "=== Arena VPS-US Setup ==="

# 1. System update
apt-get update && apt-get upgrade -y

# 2. Node.js 20 LTS
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v)"

# 3. PM2
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
  pm2 startup systemd -u root --hp /root
fi

# 4. Redis
if ! command -v redis-cli &>/dev/null; then
  apt-get install -y redis-server
  systemctl enable redis-server
  systemctl start redis-server
fi
echo "Redis: $(redis-cli ping)"

# 5. Chromium + Playwright deps
apt-get install -y \
  chromium-browser \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 \
  fonts-liberation fonts-noto-cjk

# 6. Global tools
npm install -g tsx typescript

# 7. Create project directory
mkdir -p /root/arena-worker /root/arena-bullmq/logs

# 8. Firewall (allow SSH only, Redis local only)
ufw allow 22/tcp
ufw --force enable

echo ""
echo "=== Setup Complete ==="
echo "Next steps:"
echo "  1. Copy worker code: rsync -avz worker/ root@<ip>:/root/arena-worker/"
echo "  2. Copy .env file"
echo "  3. cd /root/arena-worker && npm ci"
echo "  4. pm2 start ecosystem.config.js"

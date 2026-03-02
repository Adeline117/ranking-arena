#!/bin/bash
# Deploy HTX Cron to Singapore VPS
# VPS: 45.76.152.169

set -e

VPS_HOST="45.76.152.169"
VPS_USER="root"
REMOTE_DIR="/root/ranking-arena"

echo "=== 部署 HTX Cron 到 Singapore VPS ==="
echo "VPS: $VPS_HOST"
echo ""

# 1. 创建远程目录
echo "[1/5] 创建远程目录..."
ssh "$VPS_USER@$VPS_HOST" "mkdir -p $REMOTE_DIR /var/log/ranking-arena"

# 2. 上传cron脚本
echo "[2/5] 上传cron脚本..."
scp vps-cron-htx.sh "$VPS_USER@$VPS_HOST:$REMOTE_DIR/"
ssh "$VPS_USER@$VPS_HOST" "chmod +x $REMOTE_DIR/vps-cron-htx.sh"

# 3. 设置环境变量
echo "[3/5] 设置环境变量..."
ssh "$VPS_USER@$VPS_HOST" "cat >> ~/.bashrc << 'EOF'

# Ranking Arena Environment Variables
export CRON_SECRET='arena-cron-secret-2025'
export API_ENDPOINT='https://ranking-arena.vercel.app'
EOF
"

# 4. 安装crontab
echo "[4/5] 安装crontab..."
scp vps-crontab-htx.txt "$VPS_USER@$VPS_HOST:/tmp/"
ssh "$VPS_USER@$VPS_HOST" "crontab /tmp/vps-crontab-htx.txt"

# 5. 验证安装
echo "[5/5] 验证安装..."
ssh "$VPS_USER@$VPS_HOST" "crontab -l"

echo ""
echo "✅ 部署完成！"
echo ""
echo "下一步："
echo "1. 手动测试: ssh root@$VPS_HOST '$REMOTE_DIR/vps-cron-htx.sh'"
echo "2. 查看日志: ssh root@$VPS_HOST 'tail -f /var/log/ranking-arena/htx-futures-*.log'"
echo "3. 验证cron: ssh root@$VPS_HOST 'crontab -l'"

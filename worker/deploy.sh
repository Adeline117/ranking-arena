#!/bin/bash
# Deploy Arena Pipeline Worker to Mac Mini
#
# Run from project root on Mac Mini:
#   bash worker/deploy.sh
#
# Prerequisites:
#   - Node.js >= 20
#   - npm install (project deps)
#   - worker/.env configured
#   - pm2 installed globally (npm install -g pm2)

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Arena Pipeline Worker Deploy ==="

# 1. Check prerequisites
command -v pm2 >/dev/null 2>&1 || { echo "Installing PM2..."; npm install -g pm2; }
command -v npx >/dev/null 2>&1 || { echo "ERROR: npx not found"; exit 1; }

if [ ! -f worker/.env ]; then
  echo "ERROR: worker/.env not found. Copy worker/.env.example and fill in values."
  exit 1
fi

# 2. Verify Redis connection
echo "Testing Redis connection..."
node -e "
  require('dotenv').config({ path: 'worker/.env' });
  const IORedis = require('ioredis');
  const r = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false, tls: {} });
  r.ping().then(p => { console.log('Redis: ' + p); r.quit(); }).catch(e => { console.error('Redis FAILED:', e.message); process.exit(1); });
" || exit 1

# 3. Create log directory
mkdir -p worker/logs

# 4. Stop existing worker (if running)
pm2 delete arena-worker 2>/dev/null || true

# 5. Start worker
echo "Starting worker..."
pm2 start worker/ecosystem.config.cjs

# 6. Save PM2 process list (survives reboot)
pm2 save

# 7. Setup PM2 startup (auto-start on Mac Mini reboot)
echo ""
echo "To auto-start on reboot, run:"
echo "  pm2 startup"
echo "  (then run the command it outputs)"
echo ""

# 8. Show status
pm2 status
echo ""
echo "=== Deploy complete ==="
echo "  pm2 logs arena-worker    — view logs"
echo "  pm2 monit                — real-time monitoring"
echo "  pm2 restart arena-worker — restart"
echo "  pm2 stop arena-worker    — stop"

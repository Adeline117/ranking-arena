#!/bin/bash
# 验证Pipeline修复是否真正部署并生效

set -e

echo "🔍 Arena Pipeline Fix Verification"
echo "==================================="
echo ""

# 1. 检查最新CI状态
echo "1️⃣ Checking latest CI run..."
CI_STATUS=$(gh run list --limit 1 --json status,conclusion --jq '.[0].conclusion')
if [ "$CI_STATUS" = "success" ]; then
  echo "   ✅ Latest CI: SUCCESS"
else
  echo "   ❌ Latest CI: $CI_STATUS"
  echo "   Fix not deployed yet. Wait for CI to complete."
  exit 1
fi
echo ""

# 2. 检查cleanup-stuck-logs是否工作
echo "2️⃣ Testing cleanup-stuck-logs..."
set -a
source .env
set +a

CLEANUP_RESULT=$(node -e "
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
supabase.from('pipeline_logs')
  .select('id')
  .eq('status', 'running')
  .lt('started_at', thirtyMinutesAgo)
  .then(({ data, error }) => {
    if (error) {
      console.log('ERROR');
    } else {
      console.log(data.length);
    }
  });
" 2>&1)

if [ "$CLEANUP_RESULT" = "ERROR" ]; then
  echo "   ❌ Supabase connection failed"
  exit 1
elif [ "$CLEANUP_RESULT" -gt 0 ]; then
  echo "   ⚠️  Found $CLEANUP_RESULT stuck logs (>30min old)"
  echo "   Triggering cleanup..."
  curl -s "https://www.arenafi.org/api/cron/cleanup-stuck-logs" \
    -H "Authorization: Bearer ${CRON_SECRET}" | head -5
else
  echo "   ✅ No stuck logs found"
fi
echo ""

# 3. 检查Pipeline健康状态
echo "3️⃣ Checking pipeline health..."
HEALTH=$(node scripts/openclaw/pipeline-health-monitor.mjs 2>&1 | grep -A 5 "Summary:")

echo "$HEALTH"
echo ""

# 4. 检查批量enrichment超时配置
echo "4️⃣ Verifying getPlatformTimeout deployment..."
echo "   (Manual check: inspect batch-enrich logs for platform-specific timeouts)"
echo "   Expected: bitunix=30s, binance=60s, hyperliquid=120s, bybit=180s"
echo ""

echo "==================================="
echo "✅ Verification complete!"
echo ""
echo "Next steps:"
echo "1. Monitor next batch-enrich run for timeout improvements"
echo "2. Check if failed job count decreases over next 2-4 hours"
echo "3. Review PIPELINE_ROOT_CAUSE_ANALYSIS.md for full context"

#!/bin/bash
# Verify batch-fetch-traders pipeline fix
# Run this after Vercel deployment completes

echo "🔍 Verifying Batch-Fetch-Traders Pipeline Fix"
echo "=============================================="
echo ""

# Check Vercel deployment status
echo "1️⃣  Checking Vercel deployment status..."
npx vercel ls --prod 2>&1 | head -5
echo ""

# Check pipeline health
echo "2️⃣  Checking pipeline health..."
node scripts/openclaw/pipeline-health-monitor.mjs
echo ""

# Verify vercel.json changes
echo "3️⃣  Verifying vercel.json cron config..."
echo "Active batch-fetch-traders groups:"
grep -A1 "batch-fetch-traders" vercel.json | grep "group=" | sed 's/.*group=/  - group=/' | sed 's/".*//'
echo ""

# Check route.ts GROUPS config
echo "4️⃣  Verifying route.ts GROUPS config..."
echo "Groups with platforms:"
grep -A1 "^  [a-z0-9]*:" app/api/cron/batch-fetch-traders/route.ts | grep -v "^--$" | grep -v "//" | awk '/^  [a-z]/ {group=$1} /\[/ {print group, $0}'
echo ""

# Expected results
echo "✅ Expected Results:"
echo "   - vercel.json should have 8 batch-fetch-traders cron jobs (removed a2, b, c, d2)"
echo "   - route.ts should have 8 non-empty groups"
echo "   - Pipeline health should be >95% after next cron cycle"
echo ""
echo "📊 Next Steps:"
echo "   1. Wait for Vercel deployment to complete"
echo "   2. Wait for next cron cycle (up to 6 hours for all groups)"
echo "   3. Run this script again to verify health improved"

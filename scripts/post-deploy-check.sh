#!/bin/bash
# Post-deploy smoke test — run after every Vercel deployment
# Usage: scripts/post-deploy-check.sh [base_url]
#
# This script tests the 5 critical paths. If ANY returns 500,
# the deployment should be rolled back immediately.

BASE="${1:-https://www.arenafi.org}"
PASS=0
FAIL=0

echo "🔍 Post-deploy check: $BASE"
echo ""

for path in \
  "/" \
  "/trader/soul" \
  "/login" \
  "/pricing" \
  "/api/health"; do

  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${BASE}${path}")
  if [ "$STATUS" = "500" ] || [ "$STATUS" = "000" ]; then
    echo "❌ FAIL [$STATUS] $path"
    FAIL=$((FAIL+1))
  else
    echo "✅ PASS [$STATUS] $path"
    PASS=$((PASS+1))
  fi
done

echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "🚨 $FAIL/$((PASS+FAIL)) FAILED — ROLL BACK DEPLOYMENT"
  echo "   Vercel Dashboard → Deployments → previous green deploy → Promote to Production"
  exit 1
else
  echo "✅ $PASS/$((PASS+FAIL)) passed — deployment is healthy"
  exit 0
fi

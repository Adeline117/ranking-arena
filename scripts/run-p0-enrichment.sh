#!/bin/bash
# P0 Enrichment Master Script
# Runs all 4 P0 exchange enrichments sequentially

cd ~/ranking-arena

LOG_FILE="/tmp/p0_enrichment.log"
echo "🚀 Starting P0 Enrichment - $(date)" > "$LOG_FILE"

echo "───────────────────────────────────────" | tee -a "$LOG_FILE"
echo "1/4: BingX Spot (existing script)" | tee -a "$LOG_FILE"
echo "───────────────────────────────────────" | tee -a "$LOG_FILE"
node scripts/enrich-bingx-spot-mdd-v4.mjs 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "───────────────────────────────────────" | tee -a "$LOG_FILE"
echo "2/4: Bitget Futures" | tee -a "$LOG_FILE"
echo "───────────────────────────────────────" | tee -a "$LOG_FILE"
node scripts/enrich-p0-bitget-futures.mjs 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "───────────────────────────────────────" | tee -a "$LOG_FILE"
echo "3/4: HTX Futures" | tee -a "$LOG_FILE"
echo "───────────────────────────────────────" | tee -a "$LOG_FILE"
node scripts/enrich-p0-htx-futures.mjs 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "───────────────────────────────────────" | tee -a "$LOG_FILE"
echo "4/4: Binance Web3" | tee -a "$LOG_FILE"
echo "───────────────────────────────────────" | tee -a "$LOG_FILE"
node scripts/enrich-p0-binance-web3.mjs 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "✅ P0 Enrichment Complete - $(date)" | tee -a "$LOG_FILE"
echo "📊 Check data gaps:" | tee -a "$LOG_FILE"
node scripts/check-data-gaps.mjs 2>&1 | tee -a "$LOG_FILE"

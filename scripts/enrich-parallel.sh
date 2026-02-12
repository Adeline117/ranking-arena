#!/bin/bash
# Run enrichment for all platforms in parallel (3 at a time to avoid rate limits)
cd /Users/adelinewen/ranking-arena
export $(grep -v '^#' .env.local | xargs)

LIMIT=${1:-500}
LOG_DIR="/Users/adelinewen/ranking-arena/scripts/enrich-logs"
mkdir -p "$LOG_DIR"

echo "Starting parallel enrichment with limit=$LIMIT"
echo "Logs in $LOG_DIR"

# Group 1: High-priority, large gaps
run_platform() {
    local platform=$1
    echo "[$(date '+%H:%M:%S')] Starting $platform..."
    node scripts/enrich-detail-apis.mjs "$platform" --limit=$LIMIT > "$LOG_DIR/$platform.log" 2>&1
    echo "[$(date '+%H:%M:%S')] Done $platform (exit $?)"
}

# Run 3 at a time
PARALLEL=3
running=0

for platform in hyperliquid aevo mexc bitget kucoin dydx gmx gains jupiter coinex weex phemex lbank bingx bybit htx okx binance xt; do
    run_platform "$platform" &
    running=$((running + 1))
    if [ $running -ge $PARALLEL ]; then
        wait -n
        running=$((running - 1))
    fi
done

wait
echo "All platforms done!"

# Print summary
echo ""
echo "=== SUMMARY ==="
for f in "$LOG_DIR"/*.log; do
    platform=$(basename "$f" .log)
    updated=$(grep -c "✅" "$f" 2>/dev/null || echo 0)
    errors=$(grep -c "❌" "$f" 2>/dev/null || echo 0)
    echo "  $platform: $updated updated, $errors errors"
done

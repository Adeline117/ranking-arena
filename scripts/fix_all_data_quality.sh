#!/bin/bash
# Arena 数据质量 100% 修复脚本
# 运行所有 enrichment 脚本，带速率限制和错误处理

cd ~/ranking-arena
LOG_DIR="/tmp/arena_enrich_$(date +%Y%m%d_%H%M%S)"
mkdir -p $LOG_DIR

echo "=== Arena 数据质量修复 $(date) ===" | tee $LOG_DIR/master.log

# 1. WR 充实脚本（带速率限制）
echo "=== Phase 1: WR Enrichment ===" | tee -a $LOG_DIR/master.log

# 并发数限制为 3，避免 429
run_with_limit() {
  local script=$1
  local name=$2
  echo "Starting $name..." | tee -a $LOG_DIR/master.log
  nohup node "$script" > "$LOG_DIR/${name}.log" 2>&1 &
  echo $! >> /tmp/arena_pids.txt
  sleep 2  # 脚本间间隔
}

# 清空旧 PID 文件
> /tmp/arena_pids.txt

# WR 脚本 - 顺序运行避免限流
echo "Running WR scripts sequentially to avoid rate limits..."

WR_SCRIPTS=(
  "scripts/enrich-bitget-futures-wr-mdd.mjs"
  "scripts/enrich-lr-gateio-fast.mjs"
  "scripts/enrich-bitget-spot-wr-mdd.mjs"
  "scripts/enrich-mexc-wr-search.mjs"
  "scripts/enrich-bitfinex-lr-v2.mjs"
  "scripts/enrich-weex-lr.mjs"
  "scripts/enrich-okx-web3-v8.mjs"
  "scripts/enrich-dydx-wr-mdd.mjs"
  "scripts/enrich-bingx-fast.mjs"
)

for script in "${WR_SCRIPTS[@]}"; do
  if [ -f "$script" ]; then
    name=$(basename "$script" .mjs)
    echo "Running $name..."
    timeout 600 node "$script" > "$LOG_DIR/${name}.log" 2>&1
    sleep 5  # 脚本间等待
  fi
done

# 2. ROI 7d/30d 充实
echo "=== Phase 2: ROI 7d/30d Enrichment ===" | tee -a $LOG_DIR/master.log

ROI_SCRIPTS=(
  "scripts/enrich-okx-7d30d.mjs"
  "scripts/enrich-bitget-futures-7d30d.mjs"
  "scripts/enrich-bitget-spot-7d30d-v2.mjs"
  "scripts/enrich-bybit-7d30d.mjs"
  "scripts/enrich-bybit-spot-7d30d.mjs"
  "scripts/enrich-binance-spot-7d30d.mjs"
  "scripts/enrich-dydx-7d30d.mjs"
  "scripts/enrich-kucoin-snapshots-7d30d.mjs"
  "scripts/enrich-phemex-snapshots-7d30d.mjs"
  "scripts/enrich-gains-7d30d-v2.mjs"
)

for script in "${ROI_SCRIPTS[@]}"; do
  if [ -f "$script" ]; then
    name=$(basename "$script" .mjs)
    echo "Running $name..."
    timeout 600 node "$script" > "$LOG_DIR/${name}.log" 2>&1
    sleep 3
  fi
done

# 3. 检查最终状态
echo "=== Phase 3: Final Status Check ===" | tee -a $LOG_DIR/master.log

node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { count: total } = await sb.from('trader_snapshots').select('*',{count:'exact',head:true});
  const { count: wrNull } = await sb.from('trader_snapshots').select('*',{count:'exact',head:true}).is('win_rate',null);
  const { count: roi7Null } = await sb.from('trader_snapshots').select('*',{count:'exact',head:true}).is('roi_7d',null);
  console.log('Final Status:');
  console.log('  Total:', total);
  console.log('  WR Null:', wrNull, '(', ((total-wrNull)/total*100).toFixed(1), '%)');
  console.log('  ROI 7d Null:', roi7Null, '(', ((total-roi7Null)/total*100).toFixed(1), '%)');
})();
" 2>&1 | grep -v dotenv | tee -a $LOG_DIR/master.log

echo "=== Done! Logs: $LOG_DIR ===" | tee -a $LOG_DIR/master.log

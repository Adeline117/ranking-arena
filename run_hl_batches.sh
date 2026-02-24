#!/bin/bash
# Run hyperliquid enrichment batches until complete
cd /Users/adelinewen/ranking-arena
REMAINING=805
BATCH_SIZE=100

while [ $REMAINING -gt 0 ]; do
  echo "Running batch... $REMAINING traders remaining"
  node scripts/import/enrich_hyperliquid_full.mjs --resume 2>&1 | tee -a logs/enrich_hyperliquid_full_$(date +%Y-%m-%d).log
  
  # Check if completed
  if grep -q "All done!" logs/enrich_hyperliquid_full_$(date +%Y-%m-%d).log; then
    echo "All batches complete!"
    break
  fi
  
  # Update remaining count (subtract batch size)
  REMAINING=$((REMAINING - BATCH_SIZE))
  sleep 5
done

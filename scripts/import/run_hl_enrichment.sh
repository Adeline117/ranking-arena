#!/bin/bash
cd /Users/adelinewen/ranking-arena
for i in $(seq 1 30); do
  echo "=== Batch $i/30 at $(date) ==="
  node --max-old-space-size=256 scripts/import/enrich_hyperliquid_full.mjs --batch=100 --resume
  echo "--- Batch $i done ---"
  sleep 2
done
echo "ALL DONE"

#!/bin/bash
# Test all VPS scraper endpoints
# Usage: ./test-vps-scraper-all.sh

VPS_HOST="45.76.152.169"
VPS_KEY="arena-proxy-sg-2026"
VPS_URL="http://localhost:3456"

echo "==================================="
echo "Testing VPS Scraper Endpoints"
echo "Host: $VPS_HOST"
echo "==================================="
echo ""

# Array of endpoints to test
declare -A endpoints=(
  ["bybit"]="/bybit/leaderboard?pageNo=1&pageSize=3"
  ["bitget"]="/bitget/leaderboard?pageNo=1&pageSize=3"
  ["mexc"]="/mexc/leaderboard?page=1&pageSize=3"
  ["coinex"]="/coinex/leaderboard?page=1&pageSize=3"
  ["kucoin"]="/kucoin/leaderboard?page=1&pageSize=3"
  ["bingx"]="/bingx/leaderboard?pageIndex=1&pageSize=3"
  ["lbank"]="/lbank/leaderboard?page=1&pageSize=3"
  ["gateio"]="/gateio/leaderboard?page=1&pageSize=3"
)

for platform in "${!endpoints[@]}"; do
  echo "-----------------------------------"
  echo "Testing: $platform"
  echo "Endpoint: ${endpoints[$platform]}"
  echo "-----------------------------------"
  
  # Use timeout to prevent hanging
  response=$(ssh root@$VPS_HOST "timeout 60 curl -s -H 'X-Proxy-Key: $VPS_KEY' '$VPS_URL${endpoints[$platform]}'" 2>&1)
  
  # Check if response is empty or error
  if [ -z "$response" ]; then
    echo "❌ FAIL: No response (timeout or error)"
  elif echo "$response" | grep -q "error"; then
    echo "❌ FAIL: Error in response"
    echo "$response" | head -5
  elif echo "$response" | grep -q "data\|traders\|list"; then
    echo "✅ SUCCESS: Got data"
    # Show first few characters
    echo "$response" | head -c 200
    echo "..."
  else
    echo "⚠️  UNKNOWN: Unexpected response"
    echo "$response" | head -5
  fi
  
  echo ""
done

echo "==================================="
echo "Test completed"
echo "==================================="

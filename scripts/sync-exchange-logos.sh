#!/usr/bin/env bash
# sync-exchange-logos.sh — Download/verify exchange logos from official sources
#
# Usage:
#   ./scripts/sync-exchange-logos.sh          # verify all, download missing
#   ./scripts/sync-exchange-logos.sh --force   # re-download all
#   ./scripts/sync-exchange-logos.sh okx gmx   # only these exchanges
#
# Source of truth: Google Favicon Service (fetches from official exchange websites)
# This prevents CoinGecko CDN wrong-image issues that caused 17 wrong logos.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOGO_DIR="$SCRIPT_DIR/../public/icons/exchanges"
COMPONENT="$SCRIPT_DIR/../app/components/ui/ExchangeLogo.tsx"
FORCE=false
TARGETS=""

for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=true
  else
    TARGETS="$TARGETS $arg"
  fi
done

# Exchange → official domain mapping (single source of truth)
# Format: "exchange:domain" per line
EXCHANGE_DOMAINS="
binance:binance.com
bybit:bybit.com
bitget:bitget.com
mexc:mexc.com
htx:htx.com
weex:weex.com
coinex:coinex.com
okx:okx.com
kucoin:kucoin.com
gate:gate.io
bingx:bingx.com
phemex:phemex.com
hyperliquid:hyperliquid.xyz
gmx:gmx.io
dydx:dydx.exchange
jupiter:jup.ag
drift:drift.trade
aevo:aevo.xyz
vertex:vertexprotocol.com
toobit:toobit.com
btse:btse.com
cryptocom:crypto.com
bitfinex:bitfinex.com
whitebit:whitebit.com
lbank:lbank.com
pionex:pionex.com
blofin:blofin.com
xt:xt.com
uniswap:uniswap.org
pancakeswap:pancakeswap.finance
kwenta:kwenta.eth.limo
synthetix:synthetix.io
mux:mux.network
gains:gains.trade
btcc:btcc.com
bitunix:bitunix.com
bitmart:bitmart.com
etoro:etoro.com
woox:woox.io
polymarket:polymarket.com
copin:copin.io
"

downloaded=0
skipped=0
failed=0

echo "$EXCHANGE_DOMAINS" | while IFS=: read -r exchange domain; do
  [ -z "$exchange" ] && continue

  # If specific targets given, skip non-matching
  if [ -n "$TARGETS" ]; then
    echo "$TARGETS" | grep -qw "$exchange" || continue
  fi

  dest="$LOGO_DIR/${exchange}.png"

  # Skip if file exists and not forcing
  if [ -f "$dest" ] && [ "$FORCE" = false ]; then
    continue
  fi

  # Download from Google Favicon Service
  tmp="$LOGO_DIR/.tmp_${exchange}.png"
  http_code=$(curl -sL -o "$tmp" -w "%{http_code}" \
    "https://www.google.com/s2/favicons?domain=${domain}&sz=128" 2>/dev/null || echo "000")

  if [ "$http_code" != "200" ]; then
    echo "  FAIL: $exchange ($domain) — HTTP $http_code"
    rm -f "$tmp"
    continue
  fi

  # Verify it's actually an image
  file_type=$(file -b "$tmp" 2>/dev/null)
  case "$file_type" in
    *PNG*|*JPEG*|*image*)
      ;;
    *)
      echo "  FAIL: $exchange — not an image ($file_type)"
      rm -f "$tmp"
      continue
      ;;
  esac

  # Check minimum size (reject tiny/broken favicons)
  file_size=$(wc -c < "$tmp" | tr -d ' ')
  if [ "$file_size" -lt 100 ]; then
    echo "  FAIL: $exchange — too small (${file_size} bytes)"
    rm -f "$tmp"
    continue
  fi

  mv "$tmp" "$dest"
  echo "  OK: $exchange ($domain)"
done

# Verify ExchangeLogo.tsx LOCAL_LOGOS entries all have matching files
echo ""
echo "Checking for missing logo files..."
missing=0
grep "'/icons/exchanges/" "$COMPONENT" | while IFS= read -r line; do
  path=$(echo "$line" | sed -n "s/.*'\(\/icons\/exchanges\/[^']*\)'.*/\1/p")
  if [ -n "$path" ]; then
    full_path="$SCRIPT_DIR/../public${path}"
    if [ ! -f "$full_path" ]; then
      echo "  MISSING: $path"
      missing=$((missing + 1))
    fi
  fi
done

if [ "$missing" -eq 0 ] 2>/dev/null; then
  echo "  All logo files present."
fi

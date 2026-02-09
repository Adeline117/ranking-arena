#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
cd /Users/adelinewen/ranking-arena
source .env.local 2>/dev/null
/opt/homebrew/bin/node scripts/import/import_bybit_fast.mjs

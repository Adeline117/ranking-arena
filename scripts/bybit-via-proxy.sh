#!/bin/bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
cd /Users/adelinewen/ranking-arena
node scripts/import/import_bybit_fast.mjs

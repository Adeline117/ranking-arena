#!/bin/bash
# Arena Email Setup — adds Resend API key to .env.local + Vercel
#
# Usage: ./scripts/setup-resend.sh re_YOUR_API_KEY
#
# Get your key: resend.com/signup → Google login → resend.com/api-keys → Create
set -euo pipefail
KEY="${1:-}"
if [[ -z "$KEY" || ! "$KEY" =~ ^re_ ]]; then
  echo "Usage: ./scripts/setup-resend.sh re_YOUR_API_KEY"
  echo "Get key at: https://resend.com/api-keys"
  exit 1
fi
FROM="Arena <noreply@arenafi.org>"
echo "Adding to .env.local..."
grep -q '^RESEND_API_KEY=' .env.local 2>/dev/null && \
  sed -i '' "s|^RESEND_API_KEY=.*|RESEND_API_KEY=$KEY|" .env.local || \
  echo "RESEND_API_KEY=$KEY" >> .env.local
grep -q '^RESEND_FROM_EMAIL=' .env.local 2>/dev/null || \
  echo "RESEND_FROM_EMAIL=$FROM" >> .env.local
echo "Adding to Vercel..."
echo "$KEY" | npx vercel env add RESEND_API_KEY production --force 2>/dev/null || true
echo "$KEY" | npx vercel env add RESEND_API_KEY preview --force 2>/dev/null || true
echo "Done! Email sending enabled."

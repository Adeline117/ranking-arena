#!/bin/bash
# VPS Setup Script for Ranking Arena Data Fetcher
# Run on fresh Ubuntu 24.04 VPS

set -e

echo "=== Ranking Arena VPS Setup ==="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run as root (use sudo)"
  exit 1
fi

# Install Node.js 22
echo "Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

# Create app directory
mkdir -p /opt/ranking-arena
cd /opt/ranking-arena

# Create package.json
cat > package.json << 'PKGJSON'
{
  "name": "ranking-arena-fetcher",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@supabase/supabase-js": "^2.49.1",
    "p-limit": "^6.2.0",
    "playwright": "^1.50.0"
  }
}
PKGJSON

# Install dependencies
npm install
npx playwright install --with-deps chromium

# Create .env
cat > .env << 'ENVFILE'
SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=REPLACE_ME
NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENVFILE

echo ""
echo "=== Setup complete! ==="
echo "1. Edit /opt/ranking-arena/.env with your SUPABASE_SERVICE_ROLE_KEY"
echo "2. Copy scripts to /opt/ranking-arena/scripts/"
echo "3. Run: node scripts/import/refresh-all.mjs"

# Playwright Worker on VPS

## Overview
Migrates browser-based scrapers from Railway to VPS for:
- No cold start / container rebuild delays
- Persistent Chromium instance
- Lower cost ($6/mo VPS vs Railway usage-based)

## Browser-dependent platforms
- MEXC (`cex-browser`)
- KuCoin (`cex-browser`) 
- BingX (`cex-browser`)
- Plus fetchers using stealth: CoinEx, Phemex, Weex, Bitget, BloFin, LBank, Pionex

## VPS-SG Setup (45.76.152.169)

Chromium is already installed at `/snap/bin/chromium`.

```bash
# Verify Chromium works headless
ssh root@45.76.152.169 "/snap/bin/chromium --headless --no-sandbox --dump-dom https://example.com 2>/dev/null | head -5"

# Deploy Playwright worker
rsync -avz --exclude node_modules --exclude .git \
  worker/ root@45.76.152.169:/root/arena-worker/

ssh root@45.76.152.169 "cd /root/arena-worker && npm ci && npx playwright install-deps"

# Copy PM2 config
scp infra/vps-playwright/ecosystem.config.js root@45.76.152.169:/root/arena-worker/

# Start
ssh root@45.76.152.169 "cd /root/arena-worker && pm2 start ecosystem.config.js"
```

## Testing a single scraper
```bash
ssh root@45.76.152.169 "cd /root/arena-worker && npx tsx src/index.ts --platforms mexc"
```

## Stealth Configuration
The base scraper (`worker/src/scrapers/base.ts`) already includes:
- Proxy pool rotation
- Random user-agents
- Viewport randomization
- Anti-detection via Playwright launch args

Ensure `PROXY_LIST` is set in `.env` for platforms that need it.

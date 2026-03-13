# VPS Playwright Scraper Handlers

These scripts are designed to run on the VPS Playwright scraper (45.76.152.169:3456).
They intercept XHR/fetch requests from exchange copy-trading SPA pages to extract trader data.

## Deployment

1. SSH to VPS: `ssh root@45.76.152.169`
2. Copy handler files to `/opt/scraper/handlers/`
3. Register in `/opt/scraper/server.js`
4. Restart: `pm2 restart arena-scraper`

## Platforms Needing Handlers

| Platform | Page URL | Strategy |
|----------|----------|----------|
| KuCoin | https://www.kucoin.com/copytrading | Intercept `_api/copytrading/*` XHR |
| WEEX | https://www.weex.com/en/copy-trade | Intercept copy-trade API XHR |
| Kwenta | https://kwenta.eth.limo | Intercept leaderboard/stats XHR |
| BitMart | https://www.bitmart.com/copy-trading | Intercept `copy-trade/v1/*` XHR |
| BTSE | https://www.btse.com/en/futures/copy-trading | Intercept `api.btse.com` XHR |

## Pattern

Each handler:
1. Opens the page in headless Chrome
2. Sets up request interception via `page.on('response')`
3. Waits for the SPA to load and make API calls
4. Captures the JSON response from the internal API
5. Returns normalized trader data

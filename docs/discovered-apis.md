# Discovered Copy Trading APIs — VPS Playwright Discovery (2026-02-09)

Discovered by running Playwright on VPS `45.76.152.169` (Singapore) to intercept network requests
from exchange copy trading pages.

---

## ✅ Gate.io (gate.com)

**Status:** WORKING — No authentication needed

### Primary Endpoint: Leader List
- **URL:** `https://www.gate.com/apiw/v2/copy/leader/list`
- **Method:** GET
- **Auth:** None required
- **Parameters:**
  - `page` — Page number (1-indexed)
  - `page_size` — Items per page (up to 50)
  - `order_by` — Sort field: `profit_rate`, `profit`, `follow_profit`, `aum`, `max_drawdown`, `follow_num`, `sharp_ratio`
  - `sort_by` — `desc` or `asc`
  - `cycle` — Time period: `week`, `month`, `quarter`
  - `status` — `running`
  - `trader_name` — Search filter
  - `private_type` — `0` for public
  - `is_curated` — `0`
  - `label_ids` — Filter by label

### Response Structure:
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      {
        "leader_id": 20716,
        "level": 1,
        "profit": "141917.04",
        "profit_rate": "9.5402",
        "win_rate": "0.6259",
        "max_drawdown": "0.0868",
        "follow_profit": "-1326.08",
        "curr_follow_num": 17,
        "max_follow_num": 50,
        "aum": "13572.65",
        "sharp_ratio": "4.33",
        "leading_days": 96,
        "pl_ratio": "0.81",
        "create_time": 1762329868,
        "user_info": {
          "nick": "Pepper Chicken Leg and Cola",
          "nickname": "Pepper Chicken Leg and Cola",
          "avatar": "https://gavatar.staticimgs.com/...",
          "tier": 0
        },
        "label_info": {
          "text": [
            { "label_name": "Short-term" },
            { "label_name": "High Frequency" },
            { "label_name": "Conservative" }
          ]
        }
      }
    ]
  }
}
```

### Available Fields:
- `leader_id` — Unique trader ID
- `user_info.nickname` — Display name
- `user_info.avatar` — Profile image URL
- `profit_rate` — ROI as decimal ratio (9.54 = 954%)
- `profit` — Total PnL in USDT
- `win_rate` — Win rate as decimal (0.63 = 63%)
- `max_drawdown` — Max drawdown as decimal (0.09 = 9%)
- `follow_profit` — Copier PnL
- `curr_follow_num` — Current followers
- `aum` — Assets under management
- `sharp_ratio` — Sharpe ratio
- `leading_days` — Days as leader
- `pl_ratio` — P/L ratio

### Other Endpoints Discovered:
- `GET /apiw/v2/copy/leader/recommend_list` — Recommended leaders
- `GET /apiw/v2/copy/leader/plaza/new?limit=6` — New leaders
- `POST /apiw/v2/copy/api/leader/yield_curve` — Yield curve data

### Important Notes:
- **Domain is gate.com** (not gate.io — redirects 301 from gate.io → gate.com)
- **URL is /copytrading** (not /copy-trading) on gate.com
- No Cloudflare protection on API endpoints
- Rate limits unknown but appears generous

---

## ✅ Weex (weex.com → janapw.com)

**Status:** PARTIALLY WORKING — API requires browser-generated security headers

### Primary Endpoint: Trader List View
- **URL:** `https://http-gateway1.janapw.com/api/v1/public/trace/traderListView`
- **Method:** POST
- **Content-Type:** `application/json`

### Required Headers (generated client-side):
```
vs: U5J7yKv8xBbYuB9GNE0U78aP1Wrm16kW  (random per request)
x-sig: 9d723c1d40001ee7cf7a76272bdd61b1  (HMAC signature)
x-timestamp: 1770625650147  (current timestamp ms)
sidecar: 0124ab885b54...  (session token)
terminalcode: 8fbe7007ccba3ed9c9e50e39c66f4930  (device fingerprint)
terminaltype: 1
appversion: 2.0.2
language: en_US
locale: en_US
```

### Request Body:
```json
{
  "languageType": 0,
  "sortRule": 9,
  "simulation": 0,
  "pageNo": 1,
  "pageSize": 9,
  "nickName": ""
}
```

### Sort Rules:
- `0` — Default
- `2` — PnL (all-time)
- `5` — PnL (3W)
- `6` — ROI (3W)
- `7` — Win rate (3W)
- `8` — Copier PnL (all-time)
- `9` — Copier PnL (3W)

### Response Structure:
```json
{
  "code": "SUCCESS",
  "data": {
    "nextFlag": true,
    "totals": 355,
    "rows": [
      {
        "traderUserId": 4188609913,
        "traderNickName": "Vitalik Buterin",
        "headPic": "https://images.wexx.one/trace-image/...",
        "isMyTrader": false,
        "maxFollowCount": 800,
        "followCount": 782,
        "totalReturnRate": "210.39",
        "threeWeeksPNL": "0.73",
        "distributeRatio": "0.1",
        "traderLevel": 2,
        "authentic": false,
        "itemVoList": [
          { "showColumnDesc": "PnL (3W)", "showColumnValue": "1284.35" },
          { "showColumnDesc": "Copier PnL (3W)", "showColumnValue": "1974867.49" },
          { "showColumnDesc": "Win rate (3W)", "showColumnValue": "77.34", "percentColumn": true }
        ],
        "ndaysReturnRates": [0.0, ...],
        "openFollowContracts": [10000001, ...]
      }
    ]
  }
}
```

### Available Fields:
- `traderUserId` — Unique trader ID
- `traderNickName` — Display name
- `headPic` — Avatar URL
- `totalReturnRate` — ROI percentage (210.39 = 210.39%)
- `threeWeeksPNL` — 3-week PnL
- `followCount` — Current followers
- `maxFollowCount` — Max follower capacity
- `itemVoList[].showColumnValue` — Dynamic stats (PnL, Copier PnL, Win Rate)
- `traderLevel` — Trader tier
- `distributeRatio` — Profit sharing ratio

### Top Trader List (grouped):
- **URL:** `https://http-gateway1.janapw.com/api/v1/public/trace/topTraderListView`
- Returns data grouped by category (tab: `nWeekFollowerProfit`, etc.)

### Important Notes:
- **Weex is a Bitget white-label** — uses `janapw.com` (Bitget's gateway domain)
- Direct curl returns HTTP 521 — needs browser-generated `x-sig` and `sidecar` headers
- Headers appear to use HMAC signature validation
- **Needs Playwright/browser session** for reliable access

---

## ❌ BingX (bingx.com)

**Status:** BLOCKED — Cloudflare Turnstile challenge

- Both the website and all API paths return HTTP 403 with Cloudflare challenge page
- Even headless Chromium (Playwright) cannot bypass the challenge
- Requires Cloudflare solver (e.g., FlareSolver, undetected-chromedriver) or residential proxy

---

## ❌ BloFin (blofin.com)

**Status:** BLOCKED — Cloudflare Turnstile challenge

- Website returns HTTP 403 with Cloudflare challenge
- Known authenticated API at `https://openapi.blofin.com/api/v1/copy-trading/public/current-lead-traders` returns 401 (needs API key)
- **Potential fix:** Apply for BloFin API key for authenticated access

---

## ❌ MEXC (mexc.com)

**Status:** GEO-RESTRICTED + NO COPY TRADING PAGE

- `/copy-trading` URL returns 404 (redirects to main page)
- VPS IP (Singapore) is geo-restricted: `"limitReg": true, "limitLogin": true`
- No copy trading API endpoints were discovered in network traffic
- May need a non-restricted IP (US/EU) or different URL path

---

## Summary

| Exchange | Status | API URL | Auth | Notes |
|----------|--------|---------|------|-------|
| Gate.io | ✅ Working | `gate.com/apiw/v2/copy/leader/list` | None | Fully public, rich data |
| Weex | ⚠️ Partial | `janapw.com/.../traderListView` | Browser headers | Needs x-sig, sidecar |
| BingX | ❌ Blocked | N/A | N/A | Cloudflare Turnstile |
| BloFin | ❌ Blocked | N/A | API key needed | CF + auth required |
| MEXC | ❌ Blocked | N/A | N/A | Geo-restricted + 404 |

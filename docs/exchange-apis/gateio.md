# Gate.io Copy Trading API

## Overview

Gate.io provides copy trading functionality, but unlike some competitors, **all copy trade API endpoints require authentication**. There is no public leaderboard API.

**API Base URL:** `https://api.gateio.ws`

**API Version:** v4

**Documentation:** https://www.gate.io/docs/developers/apiv4/

---

## Authentication

Gate.io uses API Key + Secret authentication with signature-based requests.

### Required Headers

All private endpoints (including copytrade) require:

```
KEY: <your-api-key>
Timestamp: <current-unix-timestamp>
SIGN: <request-signature>
```

### Creating API Keys

1. Log in to Gate.io
2. Go to **Account** → **API Management**
3. Create a new API key with **read-only** permissions (sufficient for leaderboard data)
4. Save the API Key and Secret securely

⚠️ **Security Note:** Never commit API keys to version control. Use environment variables.

---

## Discovered Endpoints

### 🎯 PUBLIC Web API (No Authentication Required)

#### Primary Endpoint: Leader List

**Endpoint:** `GET https://www.gate.io/apiw/v2/copy/leader/list`

**🌟 No API keys needed!** This is the frontend web API used by the copy trading page.

**Query Parameters:**
- `page` (integer, required): Page number (starts at 1)
- `page_size` (integer, optional): Results per page (default: 20, max: 100)
- `status` (string, optional): Filter by status (`running`, `closed`, `all`)
- `order_by` (string, optional): Sort field
  - `profit_rate` - ROI/profit percentage
  - `profit` - Absolute profit
  - `aum` - Assets Under Management
  - `win_rate` - Win rate percentage
  - `max_drawdown` - Maximum drawdown
  - `sharp_ratio` - Sharpe ratio
- `sort_by` (string, optional): Sort direction (`asc`, `desc`)
- `cycle` (string, optional): Performance period
  - `week` - Weekly stats
  - `month` - Monthly stats
  - `quarter` - Quarterly stats

**Required Headers:**
```javascript
{
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.gate.io/copytrading',
  'Origin': 'https://www.gate.io'
}
```

**Response Format:**
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "list": [
      {
        "leader_id": 123456,
        "nickname": "ProTrader",
        "profit_rate": 1.255,      // 125.5% ROI (decimal)
        "profit": "50000.00",
        "aum": "1000000.00",
        "follower_num": 500,
        "win_rate": 0.6520,        // 65.20% (decimal)
        "max_drawdown": 0.0850,    // 8.50% (decimal, absolute value)
        "sharp_ratio": 2.5,
        "position_num": 150,       // Total trades
        "close_position_num": 145, // Closed trades
        "total_pnl": "75000.00",
        "avatar": "https://..."
      }
    ],
    "total": 5000,
    "has_next": true
  }
}
```

**⚠️ Important Notes:**
1. **Decimal format:** All percentages are decimals (0.8214 = 82.14%)
2. **CTA traders:** Traders with `cta_` prefix don't appear in API results
3. **Numeric IDs only:** Only numeric trader IDs (e.g., `123456`) are returned
4. **Rate limiting:** Recommended delay: 400ms between requests

---

### 🔒 Authenticated API (Requires API Keys)

For reference, these endpoints exist but require authentication:

#### API v4 Endpoints

**Base:** `https://api.gateio.ws/api/v4`

- `GET /copytrade/traders` - Full trader data (requires KEY, Timestamp, SIGN)
- `GET /copytrade/leaderboard` - Official leaderboard
- `GET /futures/copytrade/traders` - Futures copy traders

**Authentication:** See [Authentication](#authentication) section above.

---

## Implementation Approach

Since all endpoints require authentication, there are two approaches:

### Option A: Authenticated API Access (Recommended)

**Pros:**
- Official, stable API
- Rate limits are reasonable
- Full data access

**Cons:**
- Requires user to create API keys
- Need to implement signature generation

**Implementation:**
```javascript
import crypto from 'crypto';

function generateSignature(method, path, query, timestamp, secret) {
  const payload = `${method}\n${path}\n${query}\n${crypto
    .createHash('sha512')
    .update('')
    .digest('hex')}\n${timestamp}`;
  
  return crypto.createHmac('sha512', secret).update(payload).digest('hex');
}
```

### Option B: Web Scraping (Fallback)

**Pros:**
- No API keys needed
- Can access public leaderboard page

**Cons:**
- Fragile (breaks when UI changes)
- Rate limiting concerns
- More complex parsing

**Implementation:**
- Use Puppeteer/Playwright to load `https://www.gate.io/copy_trade`
- Extract data from rendered HTML/XHR requests
- Parse leaderboard table or intercept API calls from browser

---

## Rate Limits

Gate.io API v4 rate limits (from documentation):

- **Public endpoints:** 900 requests/10 seconds per IP
- **Private endpoints:** 900 requests/10 seconds per user

For our use case (periodic enrichment), this is sufficient.

---

## Data Enrichment Strategy

### What We Can Extract

1. **Trader Performance Metrics:**
   - ROI (Return on Investment)
   - PnL (Profit and Loss)
   - AUM (Assets Under Management)
   - Win rate
   - Number of followers

2. **Ranking Information:**
   - Global rank
   - Time-period specific rankings (7d, 30d, etc.)

3. **Trading Stats:**
   - Total trades
   - Average trade duration
   - Max drawdown

### Mapping to ranking-arena Schema

```javascript
{
  platform: "gateio",
  category: "copy-trading",
  trader_id: "123456",
  rank: 1,
  metrics: {
    roi: 125.5,
    pnl: 50000,
    aum: 1000000,
    followers: 500,
    winRate: 65.2
  },
  timestamp: "2026-03-02T13:00:00Z"
}
```

---

## Next Steps

1. **If API keys are available:**
   - Implement authenticated API client in `scripts/enrich-gateio.mjs`
   - Use signature-based authentication
   - Fetch top 100 traders periodically

2. **If no API keys:**
   - Implement Puppeteer-based scraper
   - Extract data from https://www.gate.io/copy_trade
   - Parse HTML or intercept network requests

---

## References

- [Gate.io API v4 Documentation](https://www.gate.io/docs/developers/apiv4/)
- [Gate.io Copy Trading](https://www.gate.io/copy_trade)
- [API Authentication Guide](https://www.gate.io/docs/developers/apiv4/#authentication)

---

**Last Updated:** 2026-03-02  
**Status:** Requires API credentials or scraping implementation  
**Difficulty:** Medium (authenticated API) | High (scraping)

# Bybit Spot API

**Status**: ✅ Discovered  
**Priority**: P1  
**Data Gap**: 43.9%  
**Last Updated**: 2026-03-02

---

## API Discovery Summary

Bybit Spot copy trading uses two main APIs:

### 1. Trader List (Ranking) API

**Endpoint:**
```
GET https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list
```

**Parameters:**
- `dataType`: `1` (Spot trading)
- `timeStamp`: `1` (24h), `2` (7d), `3` (30d), `4` (All time)
- `sortType`: `1` (ROI), `2` (Followers), `3` (PnL)
- `pageNo`: Page number (1-based)
- `pageSize`: Results per page (default 20, max 50)

**Request Example:**
```bash
curl 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?dataType=1&timeStamp=3&sortType=1&pageNo=1&pageSize=20' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
```

**⚠️  Access Note:**  
Direct HTTP requests may return `403 Forbidden` due to geo-restrictions or additional authentication requirements. Use Puppeteer/Playwright to access through browser context.

**Response Structure:**
```json
{
  "retCode": 0,
  "retMsg": "OK",
  "result": {
    "dataList": [
      {
        "leaderUserId": "191585431",
        "leaderMark": "MTkxNTg1NDMx",
        "nickName": "TraderName",
        "profilePhoto": "https://...",
        "yieldRate": "12.34",
        "cumYield": "5678.90",
        "followerNum": 123,
        "...": "..."
      }
    ],
    "totalNum": 5000
  }
}
```

**Key Fields:**
- `leaderUserId`: Numeric trader ID (stored as `source_trader_id` in DB)
- `leaderMark`: Base64-encoded ID used for detail API calls
- `nickName`: Trader display name
- `profilePhoto`: Avatar URL
- `yieldRate`: Current ROI percentage
- `cumYield`: Total PnL in USDT

---

### 2. Trader Income Detail API

**Endpoint:**
```
GET https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income
```

**Parameters:**
- `leaderMark`: Base64-encoded trader identifier (required)

**Request Example:**
```bash
curl 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=MTkxNTg1NDMx' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
```

**Response Structure:**
```json
{
  "retCode": 0,
  "retMsg": "success",
  "result": {
    "sevenDayYieldRateE4": "12340",
    "thirtyDayYieldRateE4": "45600",
    "ninetyDayYieldRateE4": "123400",
    "cumYieldRateE4": "234500",
    "sevenDayProfitE8": "12340000000",
    "thirtyDayProfitE8": "45600000000",
    "ninetyDayProfitE8": "123400000000",
    "cumClosedPnlE8": "234500000000",
    "sevenDayProfitWinRateE4": "6800",
    "thirtyDayProfitWinRateE4": "7200",
    "ninetyDayProfitWinRateE4": "6950",
    "sevenDayDrawDownE4": "-850",
    "thirtyDayDrawDownE4": "-1230",
    "ninetyDayDrawDownE4": "-1850",
    "cumTradeCount": "234",
    "sevenDayWinCount": "45",
    "thirtyDayWinCount": "156",
    "cumWinCount": "189",
    "cumLossCount": "45",
    "cumFollowerNum": "123",
    "currentFollowerCount": "98",
    "aumE8": "50000000000000",
    "sevenDaySharpeRatioE4": "23400",
    "thirtyDaySharpeRatioE4": "19800",
    "ninetyDaySharpeRatioE4": "18500"
  },
  "time": 1772486213694
}
```

### Field Mapping

| API Field | Transformation | DB Field | Type | Notes |
|-----------|----------------|----------|------|-------|
| `sevenDayYieldRateE4` | ÷ 100 | `roi_7d` | decimal | 7-day ROI % |
| `thirtyDayYieldRateE4` | ÷ 100 | `roi_30d` | decimal | 30-day ROI % |
| `ninetyDayYieldRateE4` | ÷ 100 | `roi_90d` | decimal | 90-day ROI % |
| `cumYieldRateE4` | ÷ 100 | `roi` | decimal | Cumulative ROI % |
| `sevenDayProfitE8` | ÷ 10⁸ | `pnl_7d` | decimal | 7-day PnL USDT |
| `thirtyDayProfitE8` | ÷ 10⁸ | `pnl_30d` | decimal | 30-day PnL USDT |
| `ninetyDayProfitE8` | ÷ 10⁸ | `pnl_90d` | decimal | 90-day PnL USDT |
| `cumClosedPnlE8` | ÷ 10⁸ | `pnl` | decimal | Total closed PnL USDT |
| `sevenDayProfitWinRateE4` | ÷ 100 | `win_rate_7d` | decimal | 7-day win rate % |
| `thirtyDayProfitWinRateE4` | ÷ 100 | `win_rate_30d` | decimal | 30-day win rate % |
| `ninetyDayProfitWinRateE4` | ÷ 100 | `win_rate_90d` | decimal | 90-day win rate % |
| `sevenDayDrawDownE4` | ÷ 100 (as negative) | `max_drawdown_7d` | decimal | 7-day max drawdown % |
| `thirtyDayDrawDownE4` | ÷ 100 (as negative) | `max_drawdown_30d` | decimal | 30-day max drawdown % |
| `ninetyDayDrawDownE4` | ÷ 100 (as negative) | `max_drawdown_90d` | decimal | 90-day max drawdown % |
| `cumTradeCount` | as-is | `trades_count` | integer | Total trades |
| `cumFollowerNum` | as-is | `followers` | integer | Total followers (historical) |
| `currentFollowerCount` | as-is | `followers` | integer | Current followers (preferred) |
| `aumE8` | ÷ 10⁸ | `aum` | decimal | Assets under management USDT |
| `sevenDaySharpeRatioE4` | ÷ 10000 | `sharpe_ratio_7d` | decimal | 7-day Sharpe ratio |
| `thirtyDaySharpeRatioE4` | ÷ 10000 | `sharpe_ratio_30d` | decimal | 30-day Sharpe ratio |
| `ninetyDaySharpeRatioE4` | ÷ 10000 | `sharpe_ratio_90d` | decimal | 90-day Sharpe ratio |

### Data Conversion Notes

**E4 Suffix (×10⁴):**  
Values like `12340` represent `123.40%`. Divide by 100 to get percentage.

**E8 Suffix (×10⁸):**  
Values like `12340000000` represent `123.40 USDT`. Divide by 10⁸ to get decimal.

**Drawdown:**  
API returns negative values (e.g., `-850` → `-8.50%`). Store as negative in DB.

**Win Rate Calculation:**
```javascript
const winRate = (cumWinCount / cumTradeCount) * 100
// Prefer API's period-specific win rates when available
```

**Zero Values:**  
`0` in 7d/30d fields is valid data (no activity in that period), not missing data.  
Only skip if `cumTradeCount=0 AND cumYieldE8=0` (expired/invalid profile).

---

## Implementation Strategy

### Phase 1: Get leaderUserId → leaderMark Mapping

Use Puppeteer to navigate listing API and extract mapping:

```javascript
async function getTraderMapping(page) {
  const url = 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?dataType=1&timeStamp=3&sortType=1&pageNo=1&pageSize=50'
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
  const json = JSON.parse(await page.evaluate(() => document.body.innerText))
  
  const mapping = new Map()
  for (const trader of json.result.dataList) {
    mapping.set(trader.leaderUserId, trader.leaderMark)
  }
  return mapping
}
```

### Phase 2: Fetch Detail Data

For each trader, call income API with leaderMark:

```javascript
async function fetchTraderIncome(leaderMark) {
  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(leaderMark)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
  })
  const json = await res.json()
  if (json.retCode !== 0) return null
  return parseMetrics(json.result)
}

function parseMetrics(result) {
  // Validate: skip if completely empty profile
  const cumTrade = parseInt(result.cumTradeCount || '0')
  const cumYield = parseInt(result.cumYieldE8 || '0')
  if (cumTrade === 0 && cumYield === 0) return null
  
  return {
    roi_7d: parseFloat((parseInt(result.sevenDayYieldRateE4 || '0') / 100).toFixed(2)),
    roi_30d: parseFloat((parseInt(result.thirtyDayYieldRateE4 || '0') / 100).toFixed(2)),
    pnl_7d: parseFloat((parseInt(result.sevenDayProfitE8 || '0') / 1e8).toFixed(4)),
    pnl_30d: parseFloat((parseInt(result.thirtyDayProfitE8 || '0') / 1e8).toFixed(4)),
    win_rate_7d: parseFloat((parseInt(result.sevenDayProfitWinRateE4 || '0') / 100).toFixed(2)),
    win_rate_30d: parseFloat((parseInt(result.thirtyDayProfitWinRateE4 || '0') / 100).toFixed(2)),
    max_drawdown_7d: parseFloat((parseInt(result.sevenDayDrawDownE4 || '0') / 100).toFixed(2)),
    max_drawdown_30d: parseFloat((parseInt(result.thirtyDayDrawDownE4 || '0') / 100).toFixed(2)),
    trades_count: parseInt(result.cumTradeCount || '0'),
    followers: parseInt(result.currentFollowerCount || result.cumFollowerNum || '0'),
    aum: parseFloat((parseInt(result.aumE8 || '0') / 1e8).toFixed(2)),
    sharpe_ratio: parseFloat((parseInt(result.thirtyDaySharpeRatioE4 || '0') / 10000).toFixed(4))
  }
}
```

---

## Rate Limiting

- **Listing API**: ~10 requests/minute (via browser)
- **Income API**: ~20 requests/second (direct HTTP)
- **Strategy**: Batch listing calls, parallelize income calls with concurrency=5-10

---

## Authentication

- ❌ No API key required
- ⚠️  Listing API requires browser context (geo-restriction)
- ✅ Income API works with direct HTTP requests

---

## Related Files

- Import script: `scripts/import/import_bybit_spot.mjs` (if exists)
- Enrichment: `scripts/enrich-bybit-spot.mjs` (to be created)
- Existing reference: `scripts/enrich-bybit-spot-7d30d.mjs`

---

## Known Issues

1. **Listing API 403**: Direct HTTP requests fail, must use Puppeteer/Playwright
2. **leaderMark Requirement**: Cannot query by leaderUserId directly, must map via listing
3. **Geo-restrictions**: Some regions may have limited access

---

## Discovery Log

**2026-03-02**:
- Discovered listing and income API endpoints
- Tested with real trader IDs from database
- Documented field transformations (E4/E8 notation)
- Confirmed zero values are valid data (not nulls)
- Created field mapping table for DB integration

# Bybit (Futures) API

**Status**: ✅ Documented  
**Priority**: P1  
**Data Gap**: 43.6%  
**Last Updated**: 2026-03-02  
**Discovered**: 2026-03-02 (via code analysis + existing bybit_spot implementation)

---

## API Endpoints

### 1. Trader Ranking List

**Endpoint:**
```
GET /x-api/fapi/beehive/public/v1/common/dynamic-leader-list
```

**Full URL:**
```
https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pageNo` | integer | Yes | Page number (starts from 1) |
| `pageSize` | integer | Yes | Items per page (max: 50) |
| `dataDuration` | string | Yes | Time period:<br>- `DATA_DURATION_SEVEN_DAY` (7D)<br>- `DATA_DURATION_THIRTY_DAY` (30D)<br>- `DATA_DURATION_NINETY_DAY` (90D) |
| `sortField` | string | No | Sort field (e.g., `LEADER_SORT_FIELD_SORT_ROI`) |

**Response Structure:**
```json
{
  "retCode": 0,
  "result": {
    "leaderDetails": [
      {
        "leaderUserId": "string",
        "leaderMark": "string",
        "nickName": "string",
        "profilePhoto": "string",
        "currentFollowerCount": 123,
        "metricValues": [
          "12.34%",    // [0] ROI
          "5.67%",     // [1] Max Drawdown
          "1234.56",   // [2] Follower Profit (proxy for PnL)
          "65.4%",     // [3] Win Rate
          "2.5",       // [4] Profit/Loss Ratio
          "1.8"        // [5] Sharpe Ratio
        ]
      }
    ]
  }
}
```

**Field Mapping:**

| API Field | Index | DB Column | Notes |
|-----------|-------|-----------|-------|
| `leaderUserId` / `leaderMark` | - | `source_trader_id` | Trader unique identifier |
| `nickName` | - | `handle` (trader_sources) | Display name |
| `profilePhoto` | - | `avatar_url` | Profile image URL |
| `currentFollowerCount` | - | `followers` | Follower count |
| `metricValues[0]` | 0 | `roi` | Return on Investment (%) |
| `metricValues[1]` | 1 | `max_drawdown` | Maximum Drawdown (%) |
| `metricValues[2]` | 2 | `pnl` | Follower Profit (approximate) |
| `metricValues[3]` | 3 | `win_rate` | Win Rate (%) |
| `metricValues[4]` | 4 | `profit_loss_ratio` | P/L Ratio |
| `metricValues[5]` | 5 | `sharpe_ratio` | Sharpe Ratio |

---

### 2. Trader Detail / Income

**Endpoint:**
```
GET https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `leaderMark` | string | Yes | Trader ID (from ranking list) |

**Response Structure:**
```json
{
  "retCode": 0,
  "result": {
    "sevenDayWinCount": 10,
    "sevenDayLossCount": 5,
    "sevenDayProfitWinRateE4": 6667,
    "sevenDayDrawDownE4": 1234,
    
    "thirtyDayWinCount": 40,
    "thirtyDayLossCount": 20,
    "thirtyDayProfitWinRateE4": 6666,
    "thirtyDayDrawDownE4": 2345,
    
    "ninetyDayWinCount": 120,
    "ninetyDayLossCount": 60,
    "ninetyDayProfitWinRateE4": 6667,
    "ninetyDayDrawDownE4": 3456
  }
}
```

**Field Mapping (Period-Specific):**

| Period | Win Key | Loss Key | Win Rate Key (E4) | Max DD Key (E4) |
|--------|---------|----------|-------------------|-----------------|
| 7D | `sevenDayWinCount` | `sevenDayLossCount` | `sevenDayProfitWinRateE4` | `sevenDayDrawDownE4` |
| 30D | `thirtyDayWinCount` | `thirtyDayLossCount` | `thirtyDayProfitWinRateE4` | `thirtyDayDrawDownE4` |
| 90D | `ninetyDayWinCount` | `ninetyDayLossCount` | `ninetyDayProfitWinRateE4` | `ninetyDayDrawDownE4` |

**E4 Conversion:**
- E4 values are multiplied by 10,000
- To get percentage: `E4_value / 100` (e.g., 6667 → 66.67%)
- To get decimal: `E4_value / 10000` (e.g., 6667 → 0.6667)

**Trades Count Calculation:**
```javascript
const totalTrades = winCount + lossCount
```

**Win Rate Calculation (fallback if E4 not available):**
```javascript
const winRate = totalTrades > 0 ? (winCount / totalTrades * 100) : null
```

---

## Implementation Notes

### Rate Limiting
- Use `User-Agent` header to avoid WAF blocks
- Recommended: 300-800ms delay between requests
- Watch for HTTP 403 (WAF) or 429 (rate limit)

### Error Handling
- `retCode !== 0` → API error
- Empty `leaderDetails` → no more pages
- Response starting with `<` → HTML error page (WAF block)

### Session Management
- May need to load `https://www.bybit.com/copyTrade/` first to establish session
- Cookies might be required for API access

### Futures vs Spot
- **Same API endpoints** for both Futures and Spot
- Differentiation likely happens via:
  - User interface filtering (Classic vs TradFi tabs)
  - Or additional query parameters (not yet identified)
- For this project, treat "Bybit Futures" as the main copy trading data

---

## Data Enrichment Strategy

### Primary Fields (from ranking API)
- ✅ `roi`, `max_drawdown`, `win_rate`, `sharpe_ratio`, `profit_loss_ratio`
- ✅ `followers`, `pnl` (follower profit)

### Secondary Fields (from detail API)
- ✅ `trades_count` (calculated from win/loss counts)
- ✅ More accurate `win_rate` and `max_drawdown` (E4 values)

### Recommended Approach
1. Use ranking API for initial data import
2. Use detail API for enrichment of missing `trades_count`
3. Prefer E4 values from detail API when available (higher precision)

---

## Related Files

- **Import:** `scripts/import/import_bybit_spot.mjs` (reference implementation)
- **Enrichment:** `scripts/enrich-bybit-leaderboard.mjs` (detail API enrichment)
- **New script:** `scripts/enrich-bybit-futures.mjs` (to be created)

---

## Verification Checklist

- [x] Ranking API endpoint confirmed
- [x] Detail API endpoint confirmed
- [x] Query parameters documented
- [x] Response structure documented
- [x] Field mapping defined
- [x] E4 conversion formula documented
- [x] Rate limiting strategy noted
- [ ] Implementation tested with live data
- [ ] Edge cases handled (WAF, rate limits, null values)

---

*Last verified: 2026-03-02 via code analysis of existing `import_bybit_spot.mjs` and `enrich-bybit-leaderboard.mjs`*

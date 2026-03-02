# HTX Futures API

**Status**: ✅ Complete (extracted from existing scripts)  
**Priority**: P0  
**Data Gap**: 59.2%  
**Last Updated**: 2026-03-02

---

## Trader Ranking API

### Endpoint
```
GET https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
```

### Authentication
❌ No API key required

### 请求示例
```bash
curl 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=1&pageSize=50' \
  -H 'User-Agent: Mozilla/5.0...' \
  -H 'Referer: https://futures.htx.com'
```

### 请求参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `rankType` | number | 排序类型 (1 = default) |
| `pageNo` | number | 页码 (从1开始) |
| `pageSize` | number | 每页数量 (max 50) |

### 响应示例
```json
{
  "code": 200,
  "data": {
    "itemList": [
      {
        "uid": 123456,
        "userSign": "MTIzNDU2", // Base64 encoded UID
        "imgUrl": "https://...",
        "winRate": "0.685",
        "mdd": "-12.3",
        "roi": "125.5",
        "pnl": "45230.12"
      }
    ],
    "totalPage": 10
  }
}
```

### 字段映射

| API字段 | DB字段 | 转换逻辑 |
|---------|--------|----------|
| `userSign` | `source_trader_id` | Base64 string (strip trailing =) |
| `uid` | (internal) | Numeric UID for detail API |
| `imgUrl` | `avatar_url` | Direct mapping |
| `winRate` | `win_rate` | parseFloat() × 100 if <1 |
| `mdd` | `max_drawdown` | parseFloat(), ensure negative |
| `roi` | `roi` | parseFloat() |
| `pnl` | `pnl` | parseFloat() |

---

## Trader Detail/Stats API (Optional)

### Endpoint (Experimental)
```
GET https://futures.htx.com/-/x/hbg/v1/futures/copytrading/public/stat?uid=<uid>
```

### 说明
This endpoint **may** provide `trades_count` (total transactions).

**Status**: Not confirmed working in production script. Ranking API is sufficient for most fields.

Alternatives tried:
- `/copytrading/stat?uid=XXX`
- `/copytrading/traderstat?uid=XXX`
- `/copytrading/trader/stat?uid=XXX`

### 响应 (if available)
```json
{
  "code": 200,
  "data": {
    "totalTxCount": 234,
    "otherFields": "..."
  }
}
```

---

## 注意事项

### User Sign (Trader ID)
⚠️ HTX uses **Base64-encoded UIDs** as `userSign`

**Example**:
- UID: `123456`
- userSign: `MTIzNDU2` (Base64)

**Processing**:
```javascript
const sign = (item.userSign || '').replace(/=+$/, '') // Strip trailing =
```

### Pagination
- **Max pageSize**: 50
- **Total pages**: Check `data.totalPage` in response
- **Recommendation**: Fetch all pages to get complete dataset

### Rate Limiting
- Unknown exact limits
- Recommendation: 200ms delay between requests

### Data Quality
From ranking API:
- ✅ `winRate` - Available
- ✅ `mdd` - Available
- ❌ `trades_count` - NOT available in ranking API
- ⚠️ Individual stat API unconfirmed

---

## 实现文件

- ✅ **Script**: `scripts/enrich-htx-futures-all.mjs` (working implementation)
- ✅ **Import**: `scripts/import/enrich_htx_futures_v2.mjs`
- 🔄 **Connector**: Need to create `lib/exchanges/htx-futures.ts`

---

## Data Completeness

**Current Achievement**:
- Avatar URL: ~100% coverage (from ranking API)
- Win Rate: ~100% coverage (from ranking API)
- Max Drawdown: ~100% coverage (from ranking API)
- **Trades Count**: 0% coverage (not available from ranking API)

**Gap Analysis**: 59.2% gap is primarily from missing `roi_7d`, `roi_30d` (ranking API only returns overall stats)

### Potential Improvement
To reduce the 59.2% gap, need to:
1. Find multi-period endpoints (7d/30d/90d stats)
2. Or: Use trader profile page to intercept additional API calls
3. Or: Accept that HTX only provides overall stats

---

## 相关发现

From `scripts/enrich-htx-futures-all.mjs`:
- Ranking API works reliably
- Fetches ~50 traders/page
- Tested multiple stat endpoints - none confirmed working
- Current approach: Only use ranking API for avatar + winRate + mdd

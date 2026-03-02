# Bitget Futures API

**Status**: ✅ Complete (extracted from existing scripts)  
**Priority**: P0  
**Data Gap**: 67.6%  
**Last Updated**: 2026-03-02

---

## Trader Cycle Data API

### Endpoint
```
POST https://www.bitget.com/v1/trigger/trace/public/cycleData
```

### Authentication
❌ No API key required

### 请求示例
```javascript
const response = await fetch('https://www.bitget.com/v1/trigger/trace/public/cycleData', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0...',
  },
  body: JSON.stringify({
    languageType: 0,
    triggerUserId: "abc123def456",  // Hex ID (16+ chars)
    cycleTime: 30,  // 7, 30, or 90
  })
})
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `languageType` | number | ✅ | 0 for English |
| `triggerUserId` | string | ✅ | Hex trader ID (16+ chars, a-f0-9) |
| `cycleTime` | number | ✅ | Time period: 7, 30, or 90 days |

### 响应示例
```json
{
  "code": "00000",
  "msg": "success",
  "requestTime": 1234567890,
  "data": {
    "statisticsDTO": {
      "winningRate": "68.5",
      "maxRetracement": "-12.3",
      "pnl": "45230.12",
      "roi": "125.5",
      "followersCount": 156,
      "totalOrders": 234
    }
  }
}
```

### 字段映射

| API字段 | DB字段 | 转换逻辑 |
|---------|--------|----------|
| `statisticsDTO.winningRate` | `win_rate` | parseFloat() |
| `statisticsDTO.maxRetracement` | `max_drawdown` | parseFloat(), ensure negative |
| `statisticsDTO.pnl` | `pnl` | parseFloat() |
| `statisticsDTO.roi` | `roi` | parseFloat() |
| `statisticsDTO.totalOrders` | `trades_count` | parseInt() |
| `statisticsDTO.followersCount` | `followers` | parseInt() |

### Multi-Period Data
Call the API 3 times with different `cycleTime`:
```javascript
const periods = [
  { cycleTime: 7, roi_field: 'roi_7d', wr_field: 'win_rate_7d', mdd_field: 'max_drawdown_7d' },
  { cycleTime: 30, roi_field: 'roi_30d', wr_field: 'win_rate_30d', mdd_field: 'max_drawdown_30d' },
  { cycleTime: 90, roi_field: 'roi_90d', wr_field: 'win_rate_90d', mdd_field: 'max_drawdown_90d' },
]
```

---

## 注意事项

### Trader ID Format
⚠️ **Critical**: Bitget uses **hex trader IDs** (16+ characters, a-f0-9)

**Non-hex IDs** (e.g., "TraderX", "123") won't work directly:
- Must visit trader profile page first
- Intercept API requests to find the hex ID
- Store mapping: `handle → hexId`

Example garbage IDs to skip:
```javascript
const GARBAGE_IDS = new Set([
  '30d max drawdown', 'Activity', 'USD', 'EUR', 'AED', ...
])
```

### Finding Hex IDs
Use Playwright to visit profile and intercept:
```javascript
// Visit: https://www.bitget.com/copy-trading/futures/trade-center/detail?traderId=<name>
// Intercept cycleData request to get hexId from request body
page.on('request', req => {
  if (req.url().includes('/cycleData')) {
    const body = JSON.parse(req.postData())
    const hexId = body.triggerUserId  // This is the real ID
  }
})
```

### Rate Limiting
- Unknown exact limits
- Recommendation: 100-200ms delay between requests

### Data Validation
```javascript
function parseNum(v) {
  if (v == null) return null
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

// Win rate should be 0-100
if (winRate < 0 || winRate > 100) winRate = null

// Max drawdown should be negative
if (maxDD > 0) maxDD = -maxDD
```

---

## 实现文件

- ✅ **Script**: `scripts/enrich-bitget-futures-profile.mjs` (working implementation)
- ✅ **7d/30d Script**: `scripts/enrich-bitget-futures-7d30d.mjs`
- 🔄 **Connector**: Need to create `lib/exchanges/bitget-futures.ts`
- 🔄 **Import**: Can reuse `scripts/import/import_bitget_spot_fast.mjs` pattern

---

## Data Quality

**Current Status**:
- API works for hex IDs
- Non-hex IDs need profile visit + intercept
- Coverage: ~90% after enrichment

**Known Issues**:
- ~10-20% of traders have non-hex IDs → need 2-step process
- Some IDs are garbage ("30d max drawdown", currency codes) → filter out

---

## 相关发现

From `scripts/enrich-bitget-futures-profile.mjs`:
- Proven working implementation
- Handles both hex and non-hex IDs
- Supports all 3 time periods (7d, 30d, 90d)

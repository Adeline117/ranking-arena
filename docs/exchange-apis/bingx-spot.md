# BingX Spot API

**Status**: ✅ Complete (extracted from existing scripts)  
**Priority**: P0  
**Data Gap**: 78.9%  
**Last Updated**: 2026-03-02

---

## Trader Search/Detail API

### Endpoint
```
POST https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search
```

### Authentication
⚠️ **CloudFlare Protected** - Must use Playwright to capture signed headers

### 请求示例 (需要Playwright捕获的headers)
```javascript
// Must capture these headers via Playwright browser:
const headers = {
  'platformid': '30',
  'appid': '30004',
  'lang': 'en',
  'timestamp': Date.now().toString(),
  'sign': '<captured from browser>',
  'device_id': '<captured from browser>',
  'User-Agent': 'Mozilla/5.0...',
}

const response = await fetch('https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    sortType: 0, // 0-5 for different sorting
    page: 1,
    rows: 20,
  })
})
```

### 请求参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `sortType` | number | 排序方式 (0-5) |
| `page` | number | 页码 |
| `rows` | number | 每页数量 |
| `nickName` | string | (Optional) 昵称搜索 |

### 响应示例
```json
{
  "code": 0,
  "data": {
    "result": [
      {
        "trader": {
          "uid": "123456",
          "nickName": "TraderX",
          "traderName": "TraderX"
        },
        "rankStat": {
          "winRate": "68.5",
          "winRate90d": "68.5",
          "maxDrawdown": "-12.3",
          "maxDrawdown90d": "-12.3",
          "totalTransactions": 234,
          "chart": [
            {
              "cumulativePnlRate": "0.125",
              "date": "2024-01-01"
            }
          ]
        }
      }
    ]
  }
}
```

### 字段映射

| API字段 | DB字段 | 转换逻辑 |
|---------|--------|----------|
| `trader.uid` | `source_trader_id` | String |
| `trader.nickName` | `handle` | String |
| `rankStat.winRate` / `rankStat.winRate90d` | `win_rate` | parseFloat(), convert to % |
| `rankStat.maxDrawdown` / `rankStat.maxDrawdown90d` | `max_drawdown` | parseFloat(), ensure negative |
| `rankStat.totalTransactions` / `rankStat.totalOrders` | `trades_count` | parseInt() |
| `rankStat.chart` | (computed) | Calculate MDD from equity curve |

### MDD Calculation from Equity Curve
```javascript
function calcMddFromChart(chart) {
  if (!chart || chart.length < 2) return null
  const equities = chart.map(p => 1 + parseFloat(p.cumulativePnlRate || 0))
  let peak = equities[0], maxDD = 0
  for (const eq of equities) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = (peak - eq) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0.0001 ? Math.round(maxDD * 10000) / 100 : null
}
```

---

## 注意事项

### CloudFlare Bypass
- **必须使用Playwright** 访问 `https://bingx.com/en/CopyTrading?type=spot`
- 捕获请求的 `sign`, `device_id`, `timestamp` headers
- 使用CDP (Chrome DevTools Protocol) 监听网络请求

### Rate Limiting
- Unknown, use delay between requests
- Recommendation: 200-500ms delay

### Nickname Search Endpoint
对于排行榜之外的trader，可以用nickname搜索：
```
POST https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search
Body: { "nickName": "TraderX", "page": 1, "rows": 1 }
```

---

## 实现文件

- ✅ **Script**: `scripts/enrich-bingx-spot-mdd-v4.mjs` (working implementation)
- 🔄 **Connector**: Need to create `lib/exchanges/bingx-spot.ts`
- 🔄 **Import**: Need to create `scripts/import/import_bingx_spot_v2.mjs`

---

## Data Quality

**Current Status** (from script):
- Successfully enriches win_rate and max_drawdown
- Uses Playwright to bypass CloudFlare
- Handles multiple sortType values to expand beyond top-63
- Fallback to nickname search for missing traders

**Coverage**: Can reach ~90%+ of traders after enrichment

---

## 相关发现

从 `scripts/enrich-bingx-spot-mdd-v4.mjs` 提取的完整实现。

该脚本证明：
1. BingX API 可用
2. CloudFlare 可bypass (Playwright)
3. 数据字段完整（win_rate, max_drawdown, trades_count）

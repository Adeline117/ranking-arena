# Binance Web3 API

**Status**: ✅ Complete (extracted from existing scripts)  
**Priority**: P0  
**Data Gap**: 54.4%  
**Last Updated**: 2026-03-02

---

## Wallet Leaderboard API

### Endpoint
```
GET https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query
```

### Authentication
❌ No API key required

### 请求示例
```bash
curl 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=1&pageSize=100&sortBy=0&orderBy=0&period=30d&chainId=56' \
  -H 'User-Agent: Mozilla/5.0...' \
  -H 'Accept: application/json'
```

### 请求参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `tag` | string | "ALL" (all categories) |
| `pageNo` | number | 页码 (从1开始) |
| `pageSize` | number | 每页数量 (max 100) |
| `sortBy` | number | 排序方式 (0 = default) |
| `orderBy` | number | 排序顺序 (0 = desc) |
| `period` | string | 时间段: "7d", "30d", "90d" |
| `chainId` | number | 链ID: 56=BSC, 1=ETH, 8453=Base |

### 响应示例
```json
{
  "code": "000000",
  "message": null,
  "data": {
    "data": [
      {
        "address": "0x1234567890abcdef1234567890abcdef12345678",
        "addressLabel": "TraderX",
        "addressLogo": "https://...",
        "realizedPnlPercent": 1.255,
        "realizedPnl": "45230.12",
        "winRate": 0.685,
        "totalTxCnt": "234",
        "chainId": 56
      }
    ],
    "total": 500
  }
}
```

### 字段映射

| API字段 | DB字段 | 转换逻辑 |
|---------|--------|----------|
| `address` | `source_trader_id` | Lowercase hex string |
| `addressLabel` | `handle` | Fallback to address.slice(0,10) |
| `addressLogo` | `avatar_url` | Direct mapping |
| `realizedPnlPercent` | `roi` | × 100 (API returns decimal) |
| `realizedPnl` | `pnl` | parseFloat() |
| `winRate` | `win_rate` | × 100 if ≤1 |
| `totalTxCnt` | `trades_count` | parseInt() |
| `chainId` | (metadata) | BSC/ETH/Base |

---

## Multi-Chain Support

### Supported Chains

| Chain | chainId | Priority |
|-------|---------|----------|
| **BSC** | 56 | 🔥 Primary |
| **Ethereum** | 1 | Secondary |
| **Base** | 8453 | Secondary |

### Deduplication Strategy
```javascript
// Dedupe by address across chains, BSC first (priority)
const tradersMap = new Map()

for (const { chainId } of [56, 1, 8453]) {
  const items = await fetchChain(chainId)
  for (const t of items) {
    if (!tradersMap.has(t.address)) {
      tradersMap.set(t.address, t) // First seen wins
    }
  }
}
```

---

## Multi-Period Support

### Time Periods

| Period | API Value | DB Field Mapping |
|--------|-----------|------------------|
| 7 days | `"7d"` | `roi_7d`, `win_rate_7d`, etc. |
| 30 days | `"30d"` | `roi_30d`, `win_rate_30d`, etc. |
| 90 days | `"90d"` | `roi_90d`, `win_rate_90d`, etc. |

### Implementation
```javascript
const PERIOD_MAP = { '7D': '7d', '30D': '30d', '90D': '90d' }

for (const period of ['7D', '30D', '90D']) {
  const periodApi = PERIOD_MAP[period]
  const traders = await fetchAllTraders(periodApi, chainId)
  
  await supabase.from('trader_snapshots').upsert(
    traders.map(t => ({
      source: 'binance_web3',
      source_trader_id: t.address,
      season_id: period,  // '7D', '30D', '90D'
      roi: t.realizedPnlPercent * 100,
      pnl: t.realizedPnl,
      win_rate: t.winRate <= 1 ? t.winRate * 100 : t.winRate,
      trades_count: parseInt(t.totalTxCnt),
    }))
  )
}
```

---

## 注意事项

### Address Format
⚠️ Addresses are **EVM hex addresses** (0x...)

**Normalization**:
```javascript
const address = t.address.toLowerCase() // Always lowercase
```

### Win Rate Conversion
API returns winRate as:
- `0.685` (decimal 0-1) → Convert to 68.5%
- `68.5` (already %) → Keep as-is

```javascript
const winRate = t.winRate <= 1 ? t.winRate * 100 : t.winRate
```

### ROI Conversion
API returns `realizedPnlPercent` as decimal:
- `1.255` → 125.5%

```javascript
const roi = (t.realizedPnlPercent || 0) * 100
```

### Pagination
- **Max pageSize**: 100
- **Recommendation**: Fetch all pages until `items.length < pageSize`

### Rate Limiting
- Unknown exact limits
- Recommendation: 300-500ms delay between requests
- Delay 500ms between chains

---

## 实现文件

- ✅ **Script**: `scripts/import/import_binance_web3_v2.mjs` (working implementation)
- ✅ **Enrichment**: `scripts/import/enrich_binance_web3.mjs`
- 🔄 **Connector**: Need to create `lib/exchanges/binance-web3.ts`

---

## Data Quality

**Current Coverage**:
- ✅ Multi-period support (7d, 30d, 90d)
- ✅ Multi-chain support (BSC, ETH, Base)
- ✅ All core fields available

**54.4% gap explained**:
- Likely from old records before multi-period implementation
- Or: Missing `max_drawdown` (not available from API)

### Missing Fields
- ❌ `max_drawdown` - Not provided by Binance Web3 API
- ⚠️ May need to compute from transaction history (if available)

---

## 相关发现

From `scripts/import/import_binance_web3_v2.mjs`:
- **Pure API implementation** (no Puppeteer needed)
- Reliable pagination (100 traders/page)
- Multi-chain + multi-period support
- Simple JSON response structure

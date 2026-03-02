# BingX Spot (Copy Trading)

**Status**: ✅ Complete  
**Priority**: P0  
**Data Gap**: 78.9%  
**Last Updated**: 2026-03-01

---

## Trader List API (Recommend Endpoint)

### Endpoint
```
POST https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId={pageId}&pageSize=50
```

### 请求示例 (cURL - 需要签名headers)
```bash
# Headers must be captured from browser via Playwright/Puppeteer
# See scripts/import/import_bingx_mac.mjs for implementation

curl -X POST 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=0&pageSize=50' \
  -H 'platformid: 30' \
  -H 'appid: 30004' \
  -H 'mainappid: 10009' \
  -H 'lang: en' \
  -H 'timezone: -8' \
  -H 'timestamp: 1709350800000' \
  -H 'sign: {CAPTURED_SIGN}' \
  -H 'device_id: {CAPTURED_DEVICE_ID}' \
  -H 'user-agent: Mozilla/5.0...' \
  -H 'referer: https://bingx.com/' \
  -H 'origin: https://bingx.com'
```

### 请求参数 (URL Query)

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pageId` | number | ✅ | 页码（从0开始） |
| `pageSize` | number | ✅ | 每页数量（建议50） |

### 响应示例 (JSON)
```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "total": 1500,
    "result": [
      {
        "trader": {
          "uid": "123456789",
          "shortUid": "1234****6789",
          "nickName": "CryptoMaster",
          "realNickName": "CryptoMaster",
          "avatar": "https://..."
        },
        "rankStat": {
          "strRecent7DaysRate": "12.50%",
          "strRecent30DaysRate": "45.20%",
          "strRecent90DaysRate": "125.50%",
          "cumulativeProfitLoss7d": "2100.50",
          "cumulativeProfitLoss30d": "8400.00",
          "cumulativeProfitLoss90d": "45230.12",
          "winRate7d": 0.72,
          "winRate30d": 0.695,
          "winRate90d": 0.685,
          "winRate": 0.685,
          "maxDrawDown7dV2": "-5.2%",
          "maxDrawDown30dV2": "-8.1%",
          "maxDrawDown90dV2": "-12.3%",
          "maxDrawDown": "-12.3%",
          "strFollowerNum": "234"
        }
      }
    ]
  }
}
```

### 字段映射

| API字段 | DB字段 | 数据类型 | 说明 |
|---------|--------|----------|------|
| `trader.uid` | `source_trader_id` | string | 交易员ID |
| `trader.nickName` / `realNickName` | `handle` | string | 昵称 |
| `trader.avatar` | `avatar_url` | string | 头像URL |
| `rankStat.strRecent7DaysRate` | `roi_7d` | number | 7天ROI% (需parsePercent) |
| `rankStat.strRecent30DaysRate` | `roi_30d` | number | 30天ROI% (需parsePercent) |
| `rankStat.strRecent90DaysRate` | `roi_90d` | number | 90天ROI% (需parsePercent) |
| `rankStat.cumulativeProfitLoss7d` | `pnl_7d` | number | 7天PnL USDT |
| `rankStat.cumulativeProfitLoss30d` | `pnl_30d` | number | 30天PnL USDT |
| `rankStat.cumulativeProfitLoss90d` | `pnl_90d` | number | 90天PnL USDT |
| `rankStat.winRate7d` | `win_rate_7d` | number | 7天胜率 (0-1, 需×100) |
| `rankStat.winRate30d` | `win_rate_30d` | number | 30天胜率 (0-1, 需×100) |
| `rankStat.winRate90d` | `win_rate_90d` | number | 90天胜率 (0-1, 需×100) |
| `rankStat.maxDrawDown7dV2` | `max_drawdown_7d` | number | 7天最大回撤% (需parsePercent, 负数) |
| `rankStat.maxDrawDown30dV2` | `max_drawdown_30d` | number | 30天最大回撤% (需parsePercent, 负数) |
| `rankStat.maxDrawDown90dV2` | `max_drawdown_90d` | number | 90天最大回撤% (需parsePercent, 负数) |
| `rankStat.strFollowerNum` | `followers` | number | 跟单人数 |

---

## 注意事项

### Rate Limiting
- 建议: 800-1300ms delay between requests
- 策略: 分页抓取，每页50条

### Authentication
- ⚠️ **需要签名headers** — 无法直接cURL访问
- **必须使用Playwright/Puppeteer** 捕获浏览器headers
- 关键headers: `sign`, `device_id`, `timestamp`, `platformid`, `appid`
- Headers从首次`recommend` API请求中捕获

### Headers
必须的headers（从浏览器捕获）:
```
platformid: 30
appid: 30004
mainappid: 10009
lang: en
appsiteid: 0
timezone: -8
timestamp: {current_timestamp}
sign: {dynamic_signature}
device_id: {device_fingerprint}
user-agent: Mozilla/5.0...
referer: https://bingx.com/
origin: https://bingx.com
```

### 数据转换

**ROI**: 
- API返回: `"12.50%"` (字符串，带%号)
- 转换: `parseFloat(s.replace(/[+%,]/g, ''))` → `12.5`
- DB存储: `12.5` (百分比数值)

**Win Rate**:
- API返回: `0.685` (小数 0-1)
- 转换: `winRate * 100` → `68.5`
- DB存储: `68.5` (百分比 0-100)

**Max Drawdown**:
- API返回: `"-12.3%"` (字符串，负数)
- 转换: `parseFloat(s.replace(/[+%,]/g, ''))` → `-12.3`
- DB存储: `-12.3` (负数)

**PnL**:
- API返回: `"2100.50"` (字符串)
- 转换: `parseFloat(s.replace(/[+,]/g, ''))` → `2100.5`
- DB存储: `2100.5` (USDT)

---

## 实现状态

- [x] API endpoint discovered
- [x] Playwright capture tested
- [x] Response documented
- [x] Field mapping defined
- [x] Connector code written (`lib/connectors/bingx/index.ts` - TBD)
- [x] Import script created (`scripts/import/import_bingx_mac.mjs`)
- [x] Data validated in DB
- [ ] Added to cron schedule

---

## 相关文件

- Import script: `scripts/import/import_bingx_mac.mjs`
- Enrich script: `scripts/enrich_bingx_all.mjs`
- Debug script: `scripts/debug-v8-detail.mjs`

---

## 发现日志

**2026-03-01**: 
- 已发现recommend endpoint
- 通过Playwright拦截headers实现
- 支持分页，每页50条
- 字段映射完整，支持7D/30D/90D
- ⚠️ **无独立detail API** — 所有数据在leaderboard中

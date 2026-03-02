# HTX Futures (Huobi)

**Status**: ✅ Complete  
**Priority**: P0  
**Data Gap**: 59.2%  
**Last Updated**: 2026-03-01

---

## Trader List API (Rank Endpoint)

### Endpoint
```
GET https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
```

### 请求示例 (cURL)
```bash
curl 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=1&pageSize=50' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
```

### 请求参数 (URL Query)

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `rankType` | number | ✅ | 排序类型 (1=ROI) |
| `pageNo` | number | ✅ | 页码（从1开始） |
| `pageSize` | number | ✅ | 每页数量（建议50） |

### 响应示例 (JSON)
```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "total": 1200,
    "itemList": [
      {
        "uid": 123456789,
        "userSign": "abc123def456",
        "nickname": "FuturesPro",
        "avatar": "https://...",
        "roi": 1.255,
        "pnl": 45230.12,
        "winRate": 0.685,
        "mdd": 0.123,
        "followerCount": 234,
        "tradeCount": 567
      }
    ]
  }
}
```

### 字段映射

| API字段 | DB字段 | 数据类型 | 说明 |
|---------|--------|----------|------|
| `userSign` (优先) / `uid` | `source_trader_id` | string | 交易员ID (使用userSign) |
| `nickname` | `handle` | string | 昵称 |
| `avatar` | `avatar_url` | string | 头像URL |
| `roi` | `roi` | number | ROI (小数, 需×100) |
| `pnl` | `pnl` | number | PnL USDT |
| `winRate` | `win_rate` | number | 胜率 (小数0-1, 需×100) |
| `mdd` | `max_drawdown` | number | 最大回撤 (小数0-1, 需×100, 取负) |
| `followerCount` | `followers` | number | 跟单人数 |
| `tradeCount` | `trades_count` | number | 交易次数 |

---

## 注意事项

### Rate Limiting
- 建议: 500ms delay between requests
- 策略: 分页抓取，每页50条
- 实测: 可支持30+ pages

### Authentication
- ✅ **无需API key** — 公开接口
- ✅ **无需签名** — 直接HTTP GET

### Headers
基本headers即可:
```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
```

### 数据转换

**ROI**: 
- API返回: `1.255` (小数，1.255 = 125.5%)
- 转换: `roi * 100` → `125.5`
- DB存储: `125.5` (百分比)

**Win Rate**:
- API返回: `0.685` (小数 0-1)
- 转换: `winRate * 100` → `68.5`
- DB存储: `68.5` (百分比 0-100)

**Max Drawdown (MDD)**:
- API返回: `0.123` (小数 0-1, **正数**)
- 转换: `mdd * 100 * -1` → `-12.3`
- DB存储: `-12.3` (百分比, **负数**)

**PnL**:
- API返回: `45230.12` (数值)
- DB存储: `45230.12` (USDT, 不变)

---

## Pagination Strategy

```javascript
const API = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'
const traders = new Map()

for (let page = 1; page <= 30; page++) {
  const res = await fetch(`${API}?rankType=1&pageNo=${page}&pageSize=50`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000)
  })
  const data = await res.json()
  
  if (!data?.data?.itemList?.length) break
  
  for (const item of data.data.itemList) {
    const key = item.userSign || String(item.uid || '')
    if (key) traders.set(key, item)
  }
  
  console.log(`Page ${page}: +${data.data.itemList.length}, total: ${traders.size}`)
  
  if (data.data.itemList.length < 50) break
  await sleep(500)
}
```

---

## 实现状态

- [x] API endpoint discovered
- [x] cURL tested
- [x] Response documented
- [x] Field mapping defined
- [ ] Connector code written (`lib/connectors/htx/futures.ts`)
- [x] Enrich script created (`scripts/import/enrich_htx_futures_v2.mjs`)
- [x] Data validated in DB
- [ ] Added to cron schedule

---

## 相关文件

- Enrich script: `scripts/import/enrich_htx_futures_v2.mjs`

---

## 发现日志

**2026-03-01**: 
- ✅ 发现rank API endpoint
- ✅ 公开接口，无需认证
- ✅ 支持分页，响应结构清晰
- ✅ 字段映射完整（roi, pnl, winRate, mdd）
- ⚠️ **注意**: mdd返回值是正数，需转负
- ⚠️ **注意**: roi/winRate是小数（0-1或倍数），需转百分比

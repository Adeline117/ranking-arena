# Binance Web3 Wallet

**Status**: ⚠️ API Changed  
**Priority**: P0  
**Data Gap**: 54.4%  
**Last Updated**: 2026-03-01

⚠️ **WARNING**: The documented endpoint returns 404 as of 2026-03-01. API may have changed or requires authentication. Needs further investigation.

---

## Trader List API (Copy Trade Rank)

### Endpoint
```
POST https://www.binance.com/bapi/composite/v1/friendly/marketing-campaign/copy-trade/rank-list
```

### 请求示例 (cURL)
```bash
curl -X POST 'https://www.binance.com/bapi/composite/v1/friendly/marketing-campaign/copy-trade/rank-list' \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://www.binance.com' \
  -H 'Referer: https://www.binance.com/en/web3-wallet' \
  -H 'User-Agent: Mozilla/5.0...' \
  -d '{
    "pageNumber": 1,
    "pageSize": 50,
    "timeRange": "WEEKLY",
    "tradeType": "SPOT",
    "walletType": "WEB3"
  }'
```

### 请求参数 (JSON Body)

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pageNumber` | number | ✅ | 页码（从1开始） |
| `pageSize` | number | ✅ | 每页数量（最大50） |
| `timeRange` | string | ✅ | 时间窗口: WEEKLY(7D) / MONTHLY(30D) / QUARTER(90D) |
| `tradeType` | string | ✅ | 交易类型: SPOT |
| `walletType` | string | ✅ | 钱包类型: WEB3 |

### 响应示例 (JSON)
```json
{
  "code": "000000",
  "message": "success",
  "data": {
    "total": 500,
    "list": [
      {
        "encryptedUid": "ABC123XYZ789",
        "uid": "987654321",
        "nickname": "Web3Trader",
        "userPhotoUrl": "https://...",
        "roi": 125.5,
        "pnlRate": 1.255,
        "pnl": 45230.12,
        "winRate": 68.5,
        "maxDrawdown": -12.3,
        "mdd": -0.123,
        "tradeCount": 234,
        "followerCount": 567
      }
    ]
  }
}
```

### 字段映射

| API字段 | DB字段 | 数据类型 | 说明 |
|---------|--------|----------|------|
| `encryptedUid` (优先) / `uid` | `source_trader_id` | string | 交易员ID |
| `nickname` | `handle` | string | 昵称 |
| `userPhotoUrl` | `avatar_url` | string | 头像URL |
| `roi` / `pnlRate` | `roi` | number | ROI% (可能是百分比或小数) |
| `pnl` | `pnl` | number | PnL USDT |
| `winRate` | `win_rate` | number | 胜率% (通常已是0-100) |
| `maxDrawdown` / `mdd` | `max_drawdown` | number | 最大回撤% (负数) |
| `tradeCount` | `trades_count` | number | 交易次数 |
| `followerCount` | `followers` | number | 跟单人数 |

---

## Window Mapping

| DB Window | API timeRange |
|-----------|---------------|
| `7d` | `WEEKLY` |
| `30d` | `MONTHLY` |
| `90d` | `QUARTER` |

---

## 注意事项

### Rate Limiting
- 限制: ~15 requests/minute
- 策略: 4000ms delay between requests
- concurrent: 1 (避免并发)

### Authentication
- ✅ **无需API key** — 公开接口
- ✅ **无需签名**

### Headers
必须的headers:
```
Content-Type: application/json
Origin: https://www.binance.com
Referer: https://www.binance.com/en/web3-wallet
User-Agent: Mozilla/5.0...
```

### 数据转换

**ROI**: 
- API可能返回: `125.5` (百分比) 或 `1.255` (小数)
- 检测: 如果 `roi > 10` 则已是百分比，否则需×100
- DB存储: `125.5`

**Win Rate**:
- API返回: `68.5` (百分比 0-100)
- DB存储: `68.5` (不变)

**Max Drawdown**:
- API返回: `-12.3` (负数百分比)
- DB存储: `-12.3` (不变)

**PnL**:
- API返回: `45230.12` (USDT)
- DB存储: `45230.12` (不变)

---

## Trader Detail API

### Status
❌ **Individual profiles NOT publicly accessible**

Web3 wallet不提供单个trader的详情API。所有数据只能从leaderboard获取。

---

## Limitations

1. **90D Window**: 可能不可用，需测试
2. **ROI Sort**: 不支持排序参数（平台默认排序）
3. **Detail Pages**: 无公开的trader profile API
4. **Timeseries**: 无历史数据API

---

## 实现状态

- [x] API endpoint discovered
- [x] cURL tested
- [x] Response documented
- [x] Field mapping defined
- [x] Connector code written (`connectors/binance/web3.ts`)
- [ ] Import script created
- [ ] Data validated in DB
- [ ] Added to cron schedule

---

## 相关文件

- Connector: `connectors/binance/web3.ts`

---

## 发现日志

**2026-03-01**: 
- ✅ 发现rank-list endpoint
- ✅ 公开POST接口，支持分页
- ✅ 字段映射清晰
- ⚠️ **无trader detail API**
- ⚠️ **90D window可能不可用**
- ⚠️ **无排序参数** — 平台默认排序

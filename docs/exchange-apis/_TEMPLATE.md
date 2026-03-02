# {Exchange Name} API

**Status**: 🔍 Discovering | ⚠️  Partial | ✅ Complete  
**Priority**: P0 | P1 | P2  
**Data Gap**: XX.X%  
**Last Updated**: 2026-03-02

---

## Trader Detail API

### Endpoint
```
POST/GET https://api.example.com/v1/trader/detail
```

### 请求示例 (cURL)
```bash
curl -X POST 'https://api.example.com/v1/trader/detail' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: Mozilla/5.0...' \
  -H 'Referer: https://www.example.com/leaderboard' \
  -d '{"traderId":"12345"}'
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `traderId` | string | ✅ | 交易员ID |
| `timeWindow` | string | ❌ | 时间窗口: 7D/30D/ALL |

### 响应示例 (JSON)
```json
{
  "code": 0,
  "data": {
    "userId": "12345",
    "nickname": "TraderX",
    "avatar": "https://...",
    "roi": 125.5,
    "pnl": 45230.12,
    "winRate": 68.5,
    "maxDrawdown": -12.3,
    "tradesCount": 234,
    "statistics": {
      "7d": {
        "roi": 12.3,
        "pnl": 2100.0,
        "winRate": 72.0,
        "maxDrawdown": -5.2,
        "trades": 45
      },
      "30d": {
        "roi": 45.2,
        "pnl": 8400.0,
        "winRate": 69.5,
        "maxDrawdown": -8.1,
        "trades": 156
      },
      "90d": {
        "roi": 125.5,
        "pnl": 45230.12,
        "winRate": 68.5,
        "maxDrawdown": -12.3,
        "trades": 234
      }
    }
  }
}
```

### 字段映射

| API字段 | DB字段 | 数据类型 | 说明 |
|---------|--------|----------|------|
| `data.userId` | `source_trader_id` | string | 交易员ID |
| `data.nickname` | `handle` | string | 昵称 |
| `data.avatar` | `avatar_url` | string | 头像URL |
| `data.roi` | `roi` | number | 累计ROI% |
| `data.pnl` | `pnl` | number | 累计PnL USDT |
| `data.winRate` | `win_rate` | number | 胜率% (0-100) |
| `data.maxDrawdown` | `max_drawdown` | number | 最大回撤% (负数) |
| `data.tradesCount` | `trades_count` | number | 交易次数 |
| `data.statistics.7d.roi` | `roi_7d` | number | 7天ROI% |
| `data.statistics.30d.roi` | `roi_30d` | number | 30天ROI% |
| `data.statistics.90d.roi` | `roi_90d` | number | 90天ROI% |

---

## Trader List API (可选)

如果交易所也提供排行榜API，可以记录在这里。

### Endpoint
```
GET https://api.example.com/v1/leaderboard
```

### 请求示例
```bash
curl 'https://api.example.com/v1/leaderboard?limit=100&timeWindow=30D'
```

---

## 注意事项

### Rate Limiting
- 限制: XX requests/minute
- 策略: 使用delay，batch请求

### Authentication
- ❌ 不需要API key
- ✅ 需要API key: `X-API-KEY: ...`
- ⚠️  需要签名: 使用crypto.createHmac(...)

### Headers
必须的headers:
```
Content-Type: application/json
User-Agent: Mozilla/5.0...
Referer: https://www.example.com/
```

### 数据转换

**ROI**: 
- API返回: `125.5` (百分比)
- DB存储: `125.5` (保持不变)

**Win Rate**:
- API返回: `0.685` (小数) 或 `68.5` (百分比)
- DB存储: `68.5` (统一为百分比 0-100)

**Max Drawdown**:
- API返回: `-12.3` (负数) 或 `12.3` (正数)
- DB存储: `-12.3` (统一为负数)

---

## 实现状态

- [ ] API endpoint discovered
- [ ] cURL tested
- [ ] Response documented
- [ ] Field mapping defined
- [ ] Connector code written (`lib/exchanges/{exchange}.ts`)
- [ ] Import script created (`scripts/import/import_{exchange}.mjs`)
- [ ] Data validated in DB
- [ ] Added to cron schedule

---

## 相关文件

- Connector: `lib/exchanges/{exchange}.ts`
- Import script: `scripts/import/import_{exchange}.mjs`
- Enrich script: `scripts/enrich-{exchange}-detail.mjs`

---

## 发现日志

**2026-03-02**: 
- 发现detail API endpoint
- 测试返回数据结构
- 字段映射完成

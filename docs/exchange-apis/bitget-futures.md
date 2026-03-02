# Bitget Futures

**Status**: 🔍 Discovering  
**Priority**: P0  
**Data Gap**: 67.6%  
**Last Updated**: 2026-03-01

---

## Trader List API (Via Puppeteer Interception)

### Strategy
**无直接API访问** — 必须通过Puppeteer拦截网页中的API响应

### Endpoint (拦截目标)
```
Dynamic API endpoints containing:
- /api/trader
- /api/copy
- traderUid or traderId in response
```

### 实现方式 (Puppeteer)
```javascript
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const traders = new Map()
const page = await browser.newPage()

// 拦截API responses
page.on('response', async (res) => {
  const url = res.url()
  try {
    if (url.includes('/api/') && (url.includes('trader') || url.includes('copy'))) {
      const text = await res.text()
      if (text.startsWith('{') || text.startsWith('[')) {
        const json = JSON.parse(text)
        const list = json.data?.list || json.data?.traders || json.data || []
        
        if (Array.isArray(list) && list.length > 0 && list[0].traderUid) {
          for (const item of list) {
            const id = item.traderUid || item.traderId
            traders.set(id, {
              traderId: String(id),
              nickname: item.nickName || item.traderName || null,
              avatar: item.headUrl || item.avatar || null,
              roi: parseFloat(item.roi || item.roiRate || 0),
              pnl: parseFloat(item.profit || item.totalProfit || item.pnl || 0),
              winRate: parseFloat(item.winRate || 0),
              followers: parseInt(item.followerCount || item.copyCount || 0),
            })
          }
        }
      }
    }
  } catch {}
})

await page.goto('https://www.bitget.com/copytrading/futures/USDT?rule=2&sort=0')
```

### 响应示例 (推测结构)
```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "traderUid": "a1b2c3d4e5f6",
        "nickName": "TradeMaster",
        "headUrl": "https://...",
        "roi": 125.5,
        "roiRate": "125.5%",
        "profit": 45230.12,
        "pnl": 45230.12,
        "winRate": 68.5,
        "followerCount": 234,
        "copyCount": 234
      }
    ]
  }
}
```

### 字段映射 (推测)

| API字段 | DB字段 | 数据类型 | 说明 |
|---------|--------|----------|------|
| `traderUid` / `traderId` | `source_trader_id` | string | 交易员ID |
| `nickName` / `traderName` | `handle` | string | 昵称 |
| `headUrl` / `avatar` | `avatar_url` | string | 头像URL |
| `roi` / `roiRate` | `roi` | number | ROI% |
| `profit` / `totalProfit` / `pnl` | `pnl` | number | PnL USDT |
| `winRate` | `win_rate` | number | 胜率% (已是0-100) |
| `followerCount` / `copyCount` | `followers` | number | 跟单人数 |

---

## DOM Scraping (备选方案)

如果API拦截失败，可从DOM提取：

```javascript
const domTraders = await page.evaluate(() => {
  const links = document.querySelectorAll('a[href*="/trader/"]')
  return Array.from(links).map(a => {
    const match = a.href.match(/\/trader\/([a-f0-9]+)\//)
    if (!match) return null
    const text = a.textContent || ''
    const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
    return {
      traderId: match[1],
      roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : null,
    }
  }).filter(Boolean)
})
```

---

## Trader Detail API (待发现)

### 预期Endpoint
```
GET/POST https://www.bitget.com/api/copy-trade/trader/detail/{traderId}
```

### 发现方法
1. 使用Puppeteer打开排行榜页面
2. 点击第一个trader进入详情页
3. 拦截detail API请求
4. 记录URL、method、headers、response structure

---

## 注意事项

### Rate Limiting
- 未知 — 建议谨慎
- 策略: 使用delay，避免频繁请求

### Authentication
- ❌ 不需要API key (公开数据)
- ⚠️ **必须使用Puppeteer** — 无法直接HTTP访问

### Headers
必须的headers:
```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...
Referer: https://www.bitget.com/
```

### 数据转换

**ROI**: 
- API可能返回: `125.5` (数值) 或 `"125.5%"` (字符串)
- 统一处理: `parseFloat(String(s).replace(/[+%,]/g, ''))`
- DB存储: `125.5`

**Win Rate**:
- 如果API返回已是0-100，直接存储
- 如果是0-1小数，需×100

---

## 实现状态

- [ ] ~~API endpoint discovered~~ (需拦截)
- [x] Puppeteer interception tested
- [ ] Detail API discovered
- [ ] Response documented (partial)
- [ ] Field mapping defined (推测)
- [ ] Connector code written (`lib/connectors/bitget/futures.ts`)
- [x] Import script created (`scripts/import/import_bitget_spot_fast.mjs` - 仅Spot)
- [ ] Futures import script created
- [ ] Data validated in DB

---

## 相关文件

- Import script (Spot): `scripts/import/import_bitget_spot_fast.mjs`
- Enrich script: `scripts/import/enrich_bitget_futures_lr3.mjs`

---

## 发现日志

**2026-03-01**: 
- ⚠️ **无直接API** — 必须用Puppeteer拦截
- Spot版本已实现（参考`import_bitget_spot_fast.mjs`）
- Futures版本待实现
- 需要进一步discovery: 打开Futures页面拦截API

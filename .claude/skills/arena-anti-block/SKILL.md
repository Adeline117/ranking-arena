# Arena Anti-Block Patterns

交易所 API 反封锁策略。

## 封锁类型 & 对策

| 类型 | 症状 | 解决 |
|------|------|------|
| Cloudflare JS Challenge | HTML "Just a moment..." | Puppeteer + stealth |
| Cloudflare 1015 | 403 Rate Limit | 降速 + 换 IP |
| Cloudflare WAF | 403 Forbidden | CF Worker / VPS |
| Geo-block | 403/451 | 日本 VPS / ClashX |
| API Rate Limit | 429 | sleep + exponential backoff |
| Auth Required | 401 | 加 headers/cookies |

## Puppeteer (Mac Mini)

```javascript
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
puppeteer.use(StealthPlugin())

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setUserAgent('Mozilla/5.0 ...')

// 等待 CF challenge 通过
await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })
// 提取 JSON
const data = await page.evaluate(() => JSON.parse(document.body.innerText))
```

## Bybit WAF 特殊处理

Bybit API 被 WAF 保护，curl 直接 403。必须用 Puppeteer + stealth:

```javascript
// 先访问主页获取 cookies
await page.goto('https://www.bybit.com', { waitUntil: 'domcontentloaded' })
await sleep(3000)
// 再请求 API
await page.goto('https://www.bybit.com/copy-trading/api/...')
```

## 降级链

```
Mac Mini 直连 → CF Worker → VPS 代理 → Puppeteer
```

每一层失败才降到下一层，避免不必要的慢速请求。

## 平台封锁状态

| 平台 | 直连 | CF Worker | Puppeteer | VPS |
|------|------|-----------|-----------|-----|
| Binance | ✅ | ✅ | - | ✅ |
| Bybit | ❌ WAF | ✅ | ✅ | ❌ |
| BitMart | ❌ CF | ❌ | 需要 | - |
| BloFin | ❌ CF | ✅ | - | - |
| Gains | ❌ 429 | ❌ 404 | - | - |
| MEXC | ✅ | ✅ | - | ✅ |

## Chrome 版本

Mac Mini 安装了 Chrome 145.0.7632.77，Puppeteer 自动使用。

## 更新日志

- 2026-02-23: 创建 skill

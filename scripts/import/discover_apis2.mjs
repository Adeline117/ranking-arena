import { chromium } from 'playwright'
const PROXY = 'http://127.0.0.1:7890'

async function discover(name, url, filterFn) {
  console.log(`\n=== ${name} ===`)
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY } })
  const page = await (await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })).newPage()
  
  const seen = new Set()
  page.on('response', async res => {
    const u = res.url()
    const key = u.split('?')[0]
    if (seen.has(key)) return
    const ct = res.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    if (!filterFn(u)) return
    seen.add(key)
    try {
      const data = await res.json()
      const d = data?.data || data
      const s = JSON.stringify(d)
      console.log(`  ${res.status()} ${key}`)
      if (s.length < 1000) console.log(`    ${s.slice(0, 600)}`)
      else console.log(`    keys=${JSON.stringify(Object.keys(d)).slice(0,300)} len=${s.length}`)
    } catch {}
  })

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
  } catch {}
  await new Promise(r => setTimeout(r, 5000))
  await browser.close()
}

// Gate.io - try trader detail page (gate.com now)
await discover('Gate.io Detail', 'https://www.gate.io/copytrading/share?trader_id=1001',
  u => !u.includes('staticimg') && !u.includes('.css') && !u.includes('.js') && (u.includes('api') || u.includes('copy') || u.includes('leader') || u.includes('trader')))

// KuCoin - try the copytrading page to see leaderboard API structure
await discover('KuCoin Leaderboard', 'https://www.kucoin.com/copytrading',
  u => u.includes('kucoin.com') && (u.includes('copy') || u.includes('leader') || u.includes('follow')))

// CoinEx - list page to find API
await discover('CoinEx List', 'https://www.coinex.com/en/copy-trading/futures',
  u => u.includes('coinex') && (u.includes('copy') || u.includes('trader')))

// OKX Web3 leaderboard
await discover('OKX Web3', 'https://web3.okx.com/zh-hans/copy-trade/leaderboard',
  u => u.includes('okx') && (u.includes('copy') || u.includes('trade') || u.includes('leader') || u.includes('rank')))

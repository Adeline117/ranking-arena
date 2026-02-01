/**
 * Debug: 打开平台页面，记录所有 JSON API 响应到文件
 */
import { writeFileSync } from 'fs'
import { chromium } from 'playwright'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const platform = process.argv[2] || 'mexc'

const URLS = {
  mexc: 'https://www.mexc.com/futures/copyTrade/home',
  kucoin: 'https://www.kucoin.com/copy-trading/leaderboard',
  coinex: 'https://www.coinex.com/en/copy-trading/futures',
  bitget: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
  bingx: 'https://bingx.com/en/copy-trading/',
}

async function run() {
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  await sleep(500)
  
  const browser = await chromium.launch({
    headless: false, channel: 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=600,400', '--window-position=9999,9999'],
  })
  
  const responses = []
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4}', r => r.abort())
    
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const text = await res.text()
        responses.push({ url: res.url(), status: res.status(), body: text.substring(0, 2000) })
      } catch {}
    })
    
    await page.goto(URLS[platform], { timeout: 40000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    for (let i = 0; i < 25; i++) {
      const t = await page.title()
      if (!t.includes('moment') && !t.includes('Check') && t.length > 2) { console.log('CF ✅:', t); break }
      await sleep(1000)
    }
    
    await sleep(5000)
    try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)) } catch {}
    await sleep(3000)
    
    await ctx.close()
  } finally {
    await browser.close()
    await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) })
  }
  
  console.log(`\nTotal API responses: ${responses.length}`)
  
  // Find responses with arrays that look like trader data
  for (const r of responses) {
    try {
      const d = JSON.parse(r.body)
      const findArrays = (obj, path = '', depth = 0) => {
        if (depth > 3 || !obj) return
        if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
          const keys = Object.keys(obj[0]).join(',')
          console.log(`\n[${path}] ${obj.length} items — keys: ${keys.substring(0,150)}`)
          console.log('  URL:', r.url.substring(0, 100))
          console.log('  Sample:', JSON.stringify(obj[0]).substring(0, 300))
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const [k, v] of Object.entries(obj)) findArrays(v, path ? `${path}.${k}` : k, depth + 1)
        }
      }
      findArrays(d)
    } catch {}
  }
}

run().catch(e => { console.error(e); process.exit(1) })

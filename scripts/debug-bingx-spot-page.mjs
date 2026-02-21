#!/usr/bin/env node
/**
 * Debug: BingX spot page - find the API and test pagination
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Missing spot slugs
const TARGET_SLUGS = new Set([
  '_______________ ', 'trader_ua', '________', 'btc_profit',
  'mundovirtual', 'smitty_werben_man_jensen', 'low_risk_trade_jake',
  'neomin', 'm_k_profitlab', 'jptr', 'harry_maguire', 'crypto_trainding',
])

// Missing spot handles
const TARGET_HANDLES = new Set([
  'يامن ٱغا القلعة', 'Trader_UA', 'أبو محسن', 'Btc Profit',
  'MundoVirtual', 'Smitty Werben Man Jensen', 'Low Risk Trade Jake',
  'Neomin', 'M.K.Profitlab', 'JPTR', 'Harry Maguire', 'Crypto_Trainding',
])

function toSlug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
}

async function main() {
  console.log('🔍 BingX Spot Page API Debug\n')

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const allFound = new Map()
  const apisSeen = new Map()
  const capturedRequests = []

  const page = await ctx.newPage()

  page.on('request', req => {
    const url = req.url()
    if ((url.includes('qq-os.com') || url.includes('bingx.com/api')) && req.method() === 'POST') {
      capturedRequests.push({
        url,
        headers: req.headers(),
        body: req.postData()
      })
      console.log(`  → POST: ${url.replace(/\?.*$/, '').split('/').slice(-3).join('/')}`)
    }
  })

  page.on('response', async resp => {
    const url = resp.url()
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    
    try {
      const json = await resp.json().catch(() => null)
      if (!json || json.code !== 0) return
      
      const items = json?.data?.result || json?.data?.list || json?.data?.records ||
                    (Array.isArray(json?.data) ? json.data : [])
      
      if (items.length > 0) {
        const shortUrl = url.replace(/\?.*$/, '').split('/').slice(-4).join('/')
        const prev = apisSeen.get(shortUrl) || { count: 0 }
        apisSeen.set(shortUrl, { count: prev.count + items.length, total: json?.data?.total, fullUrl: url.replace(/\?.*$/, '') })
        
        if (prev.count === 0) {
          const sample = items[0]
          const trader = sample.trader || sample.traderInfo || {}
          const stat = sample.rankStat || sample.stat || sample.traderStat || {}
          const mddKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('draw'))
          const wrKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('win'))
          console.log(`\n  NEW API: ${shortUrl} - ${items.length} items (total=${json?.data?.total || '?'})`)
          console.log(`    MDD fields: ${mddKeys.join(', ') || 'NONE'}`)
          console.log(`    WR fields: ${wrKeys.join(', ') || 'NONE'}`)
          if (sample.trader) console.log(`    Sample uid=${trader.uid} nick="${trader.nickName}"`)
        }
        
        for (const item of items) {
          const trader = item.trader || item.traderInfo || {}
          const nick = trader.nickName || trader.nickname || trader.traderName || item.nickName || ''
          const uid = String(trader.uid || trader.uniqueId || item.uid || '')
          const stat = item.rankStat || item.stat || item.traderStat || {}
          const mddCandidates = ['maxDrawdown90d', 'maxDrawDown90d', 'maxDrawdown', 'maxDrawDown', 'maximumDrawDown']
          let mdd = null
          for (const k of mddCandidates) {
            if (stat[k] != null) { mdd = stat[k]; break }
          }
          // Try chart
          if (mdd == null && stat.chart) {
            const chart = stat.chart
            if (Array.isArray(chart) && chart.length > 1) {
              const rates = chart.map(p => 1 + parseFloat(p.cumulativePnlRate || 0))
              let peak = rates[0], maxDD = 0
              for (const r of rates) {
                if (r > peak) peak = r
                if (peak > 0) { const dd = (peak - r) / peak; if (dd > maxDD) maxDD = dd }
              }
              if (maxDD > 0.0001) mdd = Math.round(maxDD * 10000) / 100
            }
          }
          const wr = stat.winRate ?? stat.winRate90d ?? stat.winRate30d
          
          const slug = toSlug(nick)
          if (nick) {
            allFound.set(slug, { nick, uid, mdd, wr })
            if (TARGET_HANDLES.has(nick)) {
              console.log(`  🎯 TARGET FOUND: "${nick}" (slug=${slug}) mdd=${mdd} wr=${wr}`)
            }
          }
          if (uid) allFound.set(uid, { nick, uid, mdd, wr })
        }
      }
    } catch {}
  })

  // Load spot page
  console.log('1. Loading BingX spot copy trading page...')
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => console.log('  timeout'))
  await sleep(6000)
  console.log(`  Traders found: ${allFound.size}`)

  // Check tabs
  const tabs = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [role="tab"], [class*="tab"]')]
    return btns.slice(0, 30).map(b => b.textContent?.trim().slice(0, 30)).filter(t => t && t.length > 1)
  })
  console.log(`  Page tabs: ${[...new Set(tabs)].slice(0, 15).join(' | ')}`)

  // Scroll
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await sleep(1200)
  }
  console.log(`  After scroll: ${allFound.size} traders`)

  // Try clicking sort tabs
  for (const tabText of ['By PnL', 'By Win Rate', 'By Followers', 'By ROI', 'ROI', 'PnL', 'Win Rate']) {
    try {
      const el = page.locator(`text="${tabText}"`).first()
      if (await el.isVisible({ timeout: 800 })) {
        console.log(`\n2. Clicking tab: ${tabText}`)
        await el.click()
        await sleep(3000)
        for (let i = 0; i < 8; i++) {
          await page.evaluate(() => window.scrollBy(0, 800))
          await sleep(1000)
        }
        console.log(`  After "${tabText}": ${allFound.size} traders`)
      }
    } catch {}
  }

  // Show captured requests info
  console.log('\n\nCapture summary:')
  const postReqs = capturedRequests.filter(r => r.url.includes('spot'))
  console.log(`  Spot POST requests captured: ${postReqs.length}`)
  for (const req of postReqs.slice(0, 3)) {
    console.log(`  URL: ${req.url.replace(/\?.*$/, '').split('/').slice(-4).join('/')}`)
    console.log(`  Body: ${req.body?.slice(0, 200)}`)
    const authHeaders = Object.entries(req.headers).filter(([k]) => 
      k.toLowerCase().includes('auth') || k.toLowerCase().includes('sign') || 
      k.toLowerCase().includes('token') || k.toLowerCase().includes('timestamp') ||
      k.toLowerCase().includes('nonce') || k.toLowerCase().includes('x-')
    )
    console.log(`  Auth headers: ${authHeaders.map(([k, v]) => `${k}=${v.slice(0, 20)}`).join(', ')}`)
  }

  await browser.close()

  console.log(`\n=== SUMMARY ===`)
  console.log(`Total traders: ${allFound.size}`)
  const found = [...TARGET_HANDLES].filter(h => allFound.has(toSlug(h)))
  console.log(`Targets found: ${found.length}/${TARGET_HANDLES.size}`)
  for (const h of found) {
    const d = allFound.get(toSlug(h))
    console.log(`  "${h}": mdd=${d.mdd} wr=${d.wr}`)
  }

  console.log('\nAPIs seen:')
  for (const [url, info] of apisSeen) {
    console.log(`  ${url}: ${info.count} items (total=${info.total}) — ${info.fullUrl}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

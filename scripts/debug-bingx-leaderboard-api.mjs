#!/usr/bin/env node
/**
 * Debug: Try BingX leaderboard/swap API from within the page context
 * These are same-origin calls so no Cloudflare challenge
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Missing UIDs to search for
const TARGET_UIDS = new Set([
  '1339191395874545700', '856009244589367300', '1378910400354312200',
  '1469964778594295800', '1532885692632047623', '1373505428236574700',
  '1998800000085953', '1518262070860882000', '1008921387662278659',
])

async function main() {
  console.log('🔍 BingX Leaderboard API Test\n')

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

  const page = await ctx.newPage()
  
  console.log('Loading BingX...')
  await page.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'domcontentloaded', timeout: 60000
  }).catch(() => {})
  await sleep(6000)

  // Test various leaderboard endpoints
  const endpoints = [
    {
      name: 'swap v1 leaderboard',
      url: 'https://bingx.com/api/swap/v1/lead/traders/queryLeaderBoard',
      method: 'POST',
      body: { pageNum: 1, pageSize: 100, sortType: 'ROI', sortOrder: 'DESC' }
    },
    {
      name: 'swap v2 leaderboard',
      url: 'https://bingx.com/api/swap/v2/lead/traders/queryLeaderBoard',
      method: 'POST',
      body: { pageNum: 1, pageSize: 100, sortType: 'ROI', sortOrder: 'DESC' }
    },
    {
      name: 'swap leaderboard GET',
      url: 'https://bingx.com/api/swap/v1/lead/traders/queryLeaderBoard?pageNum=1&pageSize=100&sortType=ROI&sortOrder=DESC',
      method: 'GET',
    },
    {
      name: 'copytrading leaderboard',
      url: 'https://bingx.com/api/copytrading/v1/leaderboard?pageNum=1&pageSize=100',
      method: 'GET',
    },
    {
      name: 'copytrading leaderboard v2',
      url: 'https://bingx.com/api/copytrading/v2/leaderboard?pageNum=1&pageSize=100',
      method: 'GET',
    },
    {
      name: 'trader search by UID',
      url: 'https://bingx.com/api/copytrading/v1/trader/search?uid=1339191395874545700',
      method: 'GET',
    },
    {
      name: 'trader info by UID',
      url: 'https://bingx.com/api/copytrading/v1/trader/info?uid=1339191395874545700',
      method: 'GET',
    },
    {
      name: 'trader detail by UID',
      url: 'https://bingx.com/api/copytrading/v1/trader/detail?uid=1339191395874545700&timeType=3',
      method: 'GET',
    },
    {
      name: 'qq-os trader search',
      url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/search',
      method: 'POST',
      body: { keyword: '1339191395874545700', pageId: 0, pageSize: 10 }
    },
    {
      name: 'qq-os trader by UID direct',
      url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/stat',
      method: 'POST',
      body: { uid: '1339191395874545700', timeType: 3 }
    },
    {
      name: 'qq-os recommend page 0',
      url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=0&pageSize=100',
      method: 'POST',
    },
    {
      name: 'qq-os recommend page 10',
      url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=10&pageSize=100',
      method: 'POST',
    },
  ]

  for (const ep of endpoints) {
    try {
      const result = await page.evaluate(async ({ ep }) => {
        const opts = {
          method: ep.method || 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        }
        if (ep.body) {
          opts.headers['Content-Type'] = 'application/json'
          opts.body = JSON.stringify(ep.body)
        }
        try {
          const r = await fetch(ep.url, opts)
          const text = await r.text()
          let json = null
          try { json = JSON.parse(text) } catch {}
          return {
            status: r.status,
            ok: r.ok,
            code: json?.code,
            dataType: json?.data ? typeof json.data : 'no data',
            dataKeys: json?.data && typeof json.data === 'object' && !Array.isArray(json.data)
              ? Object.keys(json.data).slice(0, 10).join(',')
              : (Array.isArray(json.data) ? `array[${json.data.length}]` : ''),
            itemCount: json?.data?.result?.length || json?.data?.list?.length || json?.data?.records?.length || 0,
            total: json?.data?.total || json?.data?.totalCount || null,
            sampleItem: json?.data?.result?.[0] ? JSON.stringify(json.data.result[0]).slice(0, 300) : null,
            rawStart: text.slice(0, 200),
          }
        } catch (e) {
          return { error: e.message }
        }
      }, { ep })
      
      console.log(`\n${ep.name}:`)
      if (result.error) {
        console.log(`  ERROR: ${result.error}`)
      } else {
        console.log(`  status=${result.status} code=${result.code} dataType=${result.dataType}`)
        if (result.dataKeys) console.log(`  dataKeys: ${result.dataKeys}`)
        if (result.itemCount > 0) console.log(`  items=${result.itemCount} total=${result.total}`)
        if (result.sampleItem) {
          const parsed = JSON.parse(result.sampleItem)
          const trader = parsed.trader || {}
          const stat = parsed.rankStat || {}
          const mddKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('draw'))
          const wrKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('win'))
          console.log(`  sample uid=${trader.uid || parsed.uid}`)
          console.log(`  stat mdd keys: ${mddKeys.join(', ')} | wr keys: ${wrKeys.join(', ')}`)
          if (mddKeys.length > 0) {
            for (const k of mddKeys) console.log(`    ${k} = ${stat[k]}`)
          }
        }
        if (!result.ok && !result.sampleItem) {
          console.log(`  rawStart: ${result.rawStart}`)
        }
      }
    } catch (e) {
      console.log(`  OUTER ERROR: ${e.message}`)
    }
    await sleep(500)
  }

  await browser.close()
  console.log('\nDone')
}

main().catch(e => { console.error(e); process.exit(1) })

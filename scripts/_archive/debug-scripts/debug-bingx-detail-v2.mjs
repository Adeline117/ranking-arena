#!/usr/bin/env node
/**
 * Debug: What API responses does a BingX trader detail page make?
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const TEST_UIDS = [
  '1339191395874545700', // "golden faucet"
  '856009244589367300',  // "懶散的刻耳柏洛斯"
  '1998800000085953',    // "witra.socialtrading"
]

async function main() {
  console.log('🔍 BingX Trader Detail Debug v2\n')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US'
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  // Get CF cookies first
  console.log('🌐 Loading main page for CF cookies...')
  const mainPage = await ctx.newPage()
  const allMainApis = []
  mainPage.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('bingx') && !url.includes('qq-os.com')) return
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    try {
      const json = await resp.json().catch(() => null)
      if (!json?.data) return
      const d = json.data
      // Look for rankStat in result items
      const items = d.result || d.list || []
      if (items.length > 0) {
        const sample = items[0]
        const stat = sample.rankStat || {}
        const statKeys = Object.keys(stat)
        const mddKeys = statKeys.filter(k => k.toLowerCase().includes('draw') || k.toLowerCase().includes('mdd'))
        allMainApis.push({ url: url.split('?')[0].split('/').slice(-3).join('/'), items: items.length, mddKeys, sampleStat: JSON.stringify(stat).slice(0, 200) })
      }
    } catch {}
  })
  
  await mainPage.goto('https://bingx.com/en/copytrading/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await sleep(5000)
  
  console.log('\n=== Main page API calls ===')
  for (const api of allMainApis) {
    console.log(`  ${api.url}: ${api.items} items`)
    console.log(`    MDD keys: ${api.mddKeys.join(', ') || 'NONE'}`)
    console.log(`    Sample stat: ${api.sampleStat}`)
  }
  await mainPage.close()

  // Now test individual trader detail pages
  for (const uid of TEST_UIDS) {
    console.log(`\n\n=== Trader detail page for UID ${uid} ===`)
    const page = await ctx.newPage()
    const apis = []
    
    page.on('response', async resp => {
      const url = resp.url()
      if (!url.includes('bingx') && !url.includes('qq-os.com')) return
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      try {
        const json = await resp.json().catch(() => null)
        if (!json) return

        const shortUrl = url.split('?')[0].replace('https://', '').replace('bingx.com/api/', '').replace('api-app.qq-os.com/api/', '')

        if (json?.data) {
          const d = json.data
          const keys = typeof d === 'object' && !Array.isArray(d) ? Object.keys(d) : []
          const mddKeys = keys.filter(k => k.toLowerCase().includes('draw') || k.toLowerCase().includes('mdd'))
          const wrKeys = keys.filter(k => k.toLowerCase().includes('win') || k.toLowerCase().includes('wr'))
          
          // Also check nested
          const stat = d.rankStat || d.stat || d.traderStat || {}
          const statKeys = Object.keys(stat)
          const statMddKeys = statKeys.filter(k => k.toLowerCase().includes('draw') || k.toLowerCase().includes('mdd'))
          const statWrKeys = statKeys.filter(k => k.toLowerCase().includes('win') || k.toLowerCase().includes('wr'))
          
          apis.push({
            url: shortUrl,
            code: json.code,
            topKeys: keys.slice(0, 10).join(','),
            mddKeys,
            wrKeys,
            statMddKeys,
            statWrKeys,
            rawData: JSON.stringify(d).slice(0, 400)
          })
        } else {
          apis.push({ url: shortUrl, code: json.code, noData: true })
        }
      } catch {}
    })

    await page.goto(`https://bingx.com/en/copytrading/tradeDetail/${uid}`, {
      waitUntil: 'networkidle', timeout: 30000
    }).catch(() => {})
    await sleep(4000)

    // Try clicking time period tabs
    for (const tab of ['90D', '30D', '7D', 'All']) {
      try {
        const el = page.locator(`text="${tab}"`).first()
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          await el.click().catch(() => {})
          await sleep(1500)
          console.log(`  Clicked tab: ${tab}`)
        }
      } catch {}
    }
    await sleep(1500)

    console.log(`API calls (${apis.length} total):`)
    for (const api of apis) {
      if (api.noData) { console.log(`  ${api.url}: code=${api.code} (no data)`); continue }
      console.log(`  ${api.url}: code=${api.code}`)
      if (api.mddKeys.length || api.wrKeys.length) {
        console.log(`    TOP-LEVEL MDD keys: ${api.mddKeys.join(', ')} | WR keys: ${api.wrKeys.join(', ')}`)
      }
      if (api.statMddKeys.length || api.statWrKeys.length) {
        console.log(`    RANKSTAT MDD keys: ${api.statMddKeys.join(', ')} | WR keys: ${api.statWrKeys.join(', ')}`)
      }
      console.log(`    data keys: ${api.topKeys}`)
      console.log(`    raw: ${api.rawData}`)
    }

    await page.close()
  }

  await browser.close()
  console.log('\n✅ Debug done')
}

main().catch(e => { console.error(e); process.exit(1) })

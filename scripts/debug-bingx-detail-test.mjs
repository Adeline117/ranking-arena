#!/usr/bin/env node
/**
 * Debug: Full BingX detail page test with main page first
 * Tests if the trader detail page makes API calls at all
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Test two UIDs - one that should have data, one from our missing list
const TEST_UIDS = [
  '1339191395874545700',  // "golden faucet" - missing MDD
]

async function main() {
  console.log('🔍 BingX Detail Page Full Test\n')

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} }
  })

  const responses = []
  
  function setupResponseCapture(page) {
    page.on('response', async resp => {
      const url = resp.url()
      const ct = resp.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      if (!url.includes('bingx') && !url.includes('qq-os') && !url.includes('copytrading')) return
      
      try {
        const json = await resp.json().catch(() => null)
        if (!json) return
        
        const jsonStr = JSON.stringify(json)
        const hasMDD = /draw/i.test(jsonStr)
        const hasWR = /winrate|win_rate/i.test(jsonStr)
        
        const entry = {
          url: url.replace(/\?.*$/, '').split('/').slice(-3).join('/'),
          fullUrl: url,
          code: json.code,
          hasMDD,
          hasWR,
          data: json
        }
        responses.push(entry)
        
        const prefix = (hasMDD || hasWR) ? '✅' : '·'
        console.log(`  ${prefix} ${entry.url} code=${json.code} mdd=${hasMDD} wr=${hasWR}`)
        
        if (hasMDD) {
          const d = json.data || {}
          const stat = d.rankStat || d.stat || d.traderStat || d.statInfo || d
          const mddKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('draw'))
          for (const k of mddKeys) {
            console.log(`     ${k} = ${stat[k]}`)
          }
        }
      } catch {}
    })
  }

  // Step 1: Load main page first
  console.log('1. Loading main BingX copy trading page...')
  const mainPage = await ctx.newPage()
  setupResponseCapture(mainPage)
  
  await mainPage.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => console.log('  timeout'))
  await sleep(5000)
  console.log(`  Responses: ${responses.filter(r => r.hasMDD || r.hasWR).length} with MDD/WR data\n`)
  
  // Keep main page open but navigate away
  // Step 2: Navigate to trader detail pages
  for (const uid of TEST_UIDS) {
    console.log(`\n2. Testing trader UID ${uid}`)
    const beforeCount = responses.length
    
    const detailPage = await ctx.newPage()
    setupResponseCapture(detailPage)
    
    const url = `https://bingx.com/en/copytrading/tradeDetail/${uid}`
    console.log(`   URL: ${url}`)
    
    await detailPage.goto(url, {
      waitUntil: 'networkidle', timeout: 45000
    }).catch(e => console.log('   nav timeout/error:', e.message.slice(0, 50)))
    await sleep(8000)
    
    const newResponses = responses.slice(beforeCount)
    const withMDD = newResponses.filter(r => r.hasMDD)
    console.log(`   API responses: ${newResponses.length} (${withMDD.length} with MDD data)`)
    
    if (withMDD.length === 0) {
      // Check page content
      const title = await detailPage.title()
      const url2 = detailPage.url()
      console.log(`   Page title: "${title}"`)
      console.log(`   Final URL: ${url2}`)
      
      // Check if redirected
      if (!url2.includes('tradeDetail')) {
        console.log('   ⚠ REDIRECTED! The trader page redirected elsewhere')
      }
    }
    
    // Try alternative URL formats
    const altUrls = [
      `https://bingx.com/en/CopyTrading/tradeDetail/${uid}`,
    ]
    for (const altUrl of altUrls) {
      const beforeCount2 = responses.length
      console.log(`   Trying alt URL: ${altUrl}`)
      await detailPage.goto(altUrl, {
        waitUntil: 'domcontentloaded', timeout: 20000
      }).catch(() => {})
      await sleep(5000)
      const newResp = responses.slice(beforeCount2)
      console.log(`   Alt URL responses: ${newResp.length} (${newResp.filter(r => r.hasMDD).length} with MDD)`)
      const finalUrl = detailPage.url()
      if (!finalUrl.includes('tradeDetail')) {
        console.log(`   ⚠ Alt URL redirected to: ${finalUrl}`)
      }
    }
    
    await detailPage.close()
  }
  
  await browser.close()
  
  // Summary of all MDD responses
  const mddResponses = responses.filter(r => r.hasMDD)
  console.log(`\n\n=== SUMMARY ===`)
  console.log(`Total responses: ${responses.length}`)
  console.log(`Responses with MDD data: ${mddResponses.length}`)
  for (const r of mddResponses) {
    console.log(`  ${r.url}`)
    const d = r.data?.data || {}
    const stat = d.rankStat || d.stat || d
    const mddKeys = Object.keys(stat).filter(k => k.toLowerCase().includes('draw'))
    for (const k of mddKeys) console.log(`    ${k} = ${stat[k]}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

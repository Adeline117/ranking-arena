#!/usr/bin/env node
/**
 * Debug: What APIs fire when visiting trader detail page?
 * Tests both the response interceptor and evaluate-based fetch
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const TEST_UID = '1339191395874545700' // "golden faucet"

async function main() {
  console.log(`Debug trader detail: ${TEST_UID}\n`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  // STEP 1: Load main page first (establish session)
  console.log('Step 1: Loading main copy trading page...')
  const mainPage = await ctx.newPage()
  
  mainPage.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('qq-os') && !url.includes('bingx.com/api')) return
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    try {
      const json = await resp.json().catch(() => null)
      if (!json) return
      const hasDrawdown = JSON.stringify(json).toLowerCase().includes('drawdown')
      console.log(`  [main] ${url.split('/').slice(-3).join('/')} code=${json.code} hasDraw=${hasDrawdown}`)
    } catch {}
  })
  
  mainPage.on('request', req => {
    const url = req.url()
    if (url.includes('qq-os') || url.includes('bingx.com/api')) {
      console.log(`  [main] → ${req.method()} ${url.replace(/\?.*$/, '').split('/').slice(-3).join('/')}`)
    }
  })

  await mainPage.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => {})
  await sleep(4000)
  console.log('Main page loaded\n')

  // STEP 2: Load detail page (same context = shared cookies)
  console.log(`Step 2: Loading detail page for ${TEST_UID}...`)
  const detailPage = await ctx.newPage()
  
  const allResponses = []
  detailPage.on('response', async resp => {
    const url = resp.url()
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    
    try {
      const json = await resp.json().catch(() => null)
      if (!json) return
      
      const jsonStr = JSON.stringify(json)
      const hasDraw = /drawdown/i.test(jsonStr)
      const hasWin = /winrate|win_rate/i.test(jsonStr)
      
      const shortUrl = url.replace(/\?.*$/, '').split('/').slice(-3).join('/')
      allResponses.push({ url: shortUrl, code: json.code, hasDraw, hasWin, json })
      
      if (hasDraw || hasWin) {
        console.log(`  ✅ ${shortUrl} code=${json.code} draw=${hasDraw} win=${hasWin}`)
        if (json.data) {
          const stat = json.data.rankStat || json.data.stat || json.data.traderStat || json.data
          if (typeof stat === 'object' && !Array.isArray(stat)) {
            const drawKeys = Object.keys(stat).filter(k => /draw/i.test(k))
            for (const k of drawKeys) console.log(`    ${k} = ${stat[k]}`)
          }
        }
      } else {
        console.log(`  · ${shortUrl} code=${json.code}`)
      }
    } catch {}
  })
  
  detailPage.on('request', req => {
    const url = req.url()
    if (url.includes('qq-os') || url.includes('bingx.com/api')) {
      const body = req.postData() ? req.postData().slice(0, 100) : ''
      console.log(`  → ${req.method()} ${url.replace(/\?.*$/, '').split('/').slice(-3).join('/')}  ${body}`)
    }
  })

  await detailPage.goto(`https://bingx.com/en/copytrading/tradeDetail/${TEST_UID}`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  }).catch(e => console.log('Detail nav error:', e.message.slice(0, 60)))
  await sleep(6000)

  // Click all time-period tabs
  for (const tab of ['90D', '30D', '7D', 'ALL']) {
    try {
      const el = detailPage.locator(`text="${tab}"`).first()
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.click()
        await sleep(1500)
        console.log(`  Clicked ${tab}`)
      }
    } catch {}
  }

  console.log(`\nTotal JSON responses: ${allResponses.length}`)
  console.log(`With drawdown: ${allResponses.filter(r => r.hasDraw).length}`)

  // STEP 3: Try fetching directly via page.evaluate
  console.log('\nStep 3: Trying direct fetch via evaluate...')
  
  const endpoints = [
    `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/stat?uid=${TEST_UID}&timeType=3`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/stat?uid=${TEST_UID}&timeType=7`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/stat?uid=${TEST_UID}&timeType=3`,
    `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/stat?uid=${TEST_UID}&timeType=3`,
  ]

  for (const endpoint of endpoints) {
    try {
      const result = await detailPage.evaluate(async (url) => {
        try {
          const r = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
          })
          const json = await r.json()
          return {
            status: r.status,
            code: json.code,
            hasDrawdown: JSON.stringify(json).toLowerCase().includes('drawdown'),
            dataKeys: json.data ? Object.keys(json.data || {}).join(',') : 'NO DATA',
            rawStart: JSON.stringify(json).slice(0, 300)
          }
        } catch (e) {
          return { error: e.message }
        }
      }, endpoint)
      
      const shortEp = endpoint.replace(/\?.*$/, '').split('/').slice(-3).join('/')
      if (result.error) {
        console.log(`  ERROR ${shortEp}: ${result.error}`)
      } else {
        console.log(`  ${shortEp}: status=${result.status} code=${result.code} draw=${result.hasDrawdown}`)
        if (result.hasDrawdown || result.code === 0) {
          console.log(`    dataKeys: ${result.dataKeys}`)
          console.log(`    raw: ${result.rawStart}`)
        }
      }
    } catch (e) {
      console.log(`  OUTER ERROR: ${e.message}`)
    }
    await sleep(300)
  }

  // STEP 4: Check what APIs the detail page already fired automatically
  console.log('\nStep 4: Looking at what the detail page called...')
  // Try to re-call any API that had trader stat data
  try {
    const allNetworkRequests = await detailPage.evaluate(() => {
      // Intercept XHR and fetch calls already made
      return window.__capturedRequests || []
    })
    console.log(`Captured from page: ${allNetworkRequests.length}`)
  } catch {}

  // STEP 5: Try the actual API call patterns from the page's own XHR
  console.log('\nStep 5: Trying POST-based stat APIs...')
  const postEndpoints = [
    {
      url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/stat',
      body: { uid: parseInt(TEST_UID), timeType: 3 }
    },
    {
      url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/stat',
      body: { uid: parseInt(TEST_UID), timeType: 3 }
    },
    {
      url: 'https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/new/stat',
      body: { uid: parseInt(TEST_UID), timeType: 3 }
    },
    {
      url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/rank',
      body: { uid: parseInt(TEST_UID) }
    },
  ]

  for (const ep of postEndpoints) {
    try {
      const result = await detailPage.evaluate(async ({ url, body }) => {
        try {
          const r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          })
          const json = await r.json()
          return {
            status: r.status,
            code: json.code,
            hasDrawdown: JSON.stringify(json).toLowerCase().includes('drawdown'),
            dataKeys: json.data ? (typeof json.data === 'object' ? Object.keys(json.data).join(',') : String(json.data).slice(0, 100)) : 'NO DATA',
            rawStart: JSON.stringify(json).slice(0, 400)
          }
        } catch (e) {
          return { error: e.message }
        }
      }, ep)
      
      const shortEp = ep.url.split('/').slice(-3).join('/')
      if (result.error) {
        console.log(`  POST ERROR ${shortEp}: ${result.error}`)
      } else {
        console.log(`  POST ${shortEp}: status=${result.status} code=${result.code} draw=${result.hasDrawdown}`)
        if (result.hasDrawdown || result.code === 0) {
          console.log(`    dataKeys: ${result.dataKeys}`)
          console.log(`    raw: ${result.rawStart}`)
        }
      }
    } catch (e) {
      console.log(`  OUTER POST ERROR: ${e.message}`)
    }
    await sleep(300)
  }

  await browser.close()
  console.log('\nDone')
}

main().catch(e => { console.error(e); process.exit(1) })

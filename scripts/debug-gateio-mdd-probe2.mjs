#!/usr/bin/env node
/**
 * Deep probe: find MDD data for stopped Gate.io traders
 */
import { chromium } from 'playwright'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Use one stopped trader and one CTA trader as test cases
const TEST_NUMERIC_ID = '21597'
const TEST_CTA = 'galaxyquant'
const CTA_IDS = ['galaxyquant','rosesneverpanic','gateuser0eec98f2','gateuserc864817e','gateuser6ed1d847','gateuserbfda99d2','gateuser061f1d13','gateusera1af57c1','gateuser947625fb','abluk24','gateuser96a07d2e','loaitrx','gateuser19f45b51','studen','gateuserd2e4499f','gateuserca120d12','slowisfast','zhaocaiqi','gateuser3893dd1b']

async function main() {
  console.log('=== Gate.io Deep MDD Probe ===\n')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  
  console.log('Establishing session...')
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session ready\n')

  // Test A: Raw text of the detail API endpoint
  console.log('=== Test A: Raw response of /apiw/v2/copy/leader/detail ===')
  const rawDetail = await page.evaluate(async (id) => {
    try {
      const r = await fetch(`/apiw/v2/copy/leader/detail?leader_id=${id}`, {credentials: 'include'})
      const text = await r.text()
      return { status: r.status, headers: Object.fromEntries(r.headers), text_preview: text.slice(0, 200) }
    } catch(e) { return { error: e.message } }
  }, TEST_NUMERIC_ID)
  console.log('Detail raw:', JSON.stringify(rawDetail))

  // Test B: Yield curve endpoint - what params does it accept?
  console.log('\n=== Test B: /apiw/v2/copy/api/leader/yield_curve ===')
  for (const cycle of ['week', 'month', 'quarter']) {
    const result = await page.evaluate(async ({ id, cycle }) => {
      try {
        const r = await fetch(`/apiw/v2/copy/api/leader/yield_curve?leader_id=${id}&cycle=${cycle}`, {credentials: 'include'})
        const j = await r.json()
        return {
          status: r.status,
          code: j?.code,
          list_len: j?.data?.list?.length,
          sample: j?.data?.list?.slice(0, 2),
          keys: j?.data?.list?.[0] ? Object.keys(j.data.list[0]) : null
        }
      } catch(e) { return { error: e.message } }
    }, { id: TEST_NUMERIC_ID, cycle })
    console.log(`  yield_curve cycle=${cycle}:`, JSON.stringify(result))
    await sleep(200)
  }

  // Test C: Historical page for stopped trader (different URL patterns)
  console.log('\n=== Test C: Stopped trader detail page full intercept ===')
  const stoppedPage = await context.newPage()
  const stoppedCalls = []
  
  stoppedPage.on('response', async (res) => {
    const url = res.url()
    if (res.status() !== 200) return
    if (!url.includes('gate') && !url.includes('api')) return
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const j = await res.json()
      if (!j || typeof j !== 'object') return
      const str = JSON.stringify(j)
      
      // Look for our specific leader_id in the response
      if (str.includes(`"leader_id":"${TEST_NUMERIC_ID}"`) || 
          str.includes(`"leader_id":${TEST_NUMERIC_ID}`) ||
          str.includes(`"id":"${TEST_NUMERIC_ID}"`) ||
          str.includes(`"id":${TEST_NUMERIC_ID}`)) {
        stoppedCalls.push({ url: url.slice(-120), code: j?.code, has_target: true })
      }
      
      // Also capture any drawdown-related data
      if (/drawdown|retrace/i.test(str) && str.length < 5000) {
        stoppedCalls.push({ url: url.slice(-120), code: j?.code, data_preview: str.slice(0, 300) })
      }
    } catch {}
  })
  
  // Try gate.io URL (not gate.com)
  console.log('  Trying gate.io URL...')
  await stoppedPage.goto(`https://www.gate.io/copytrading/trader/${TEST_NUMERIC_ID}`, {
    waitUntil: 'networkidle', timeout: 20000
  }).catch(e => console.log('  Nav error:', e.message))
  await sleep(3000)
  
  // Try gate.com URL
  console.log('  Trying gate.com URL...')
  await stoppedPage.goto(`https://www.gate.com/copytrading/trader/${TEST_NUMERIC_ID}`, {
    waitUntil: 'networkidle', timeout: 20000
  }).catch(e => console.log('  Nav error:', e.message))
  await sleep(3000)
  
  console.log(`  Captured ${stoppedCalls.length} relevant API calls:`)
  for (const call of stoppedCalls.slice(0, 10)) {
    console.log(`    URL: ...${call.url}`)
    if (call.has_target) console.log(`    *** CONTAINS TRADER ${TEST_NUMERIC_ID} ***`)
    if (call.data_preview) console.log(`    data: ${call.data_preview.slice(0, 150)}`)
  }
  await stoppedPage.close()

  // Test D: Try in-page fetch of different API patterns on the trader detail page
  console.log('\n=== Test D: In-page fetch for stopped traders ===')
  const detailPage2 = await context.newPage()
  await detailPage2.goto(`https://www.gate.com/copytrading/trader/${TEST_NUMERIC_ID}`, {
    waitUntil: 'domcontentloaded', timeout: 20000
  }).catch(() => {})
  await sleep(2000)
  
  // Try various endpoints from within the trader's detail page
  const apiTests = [
    `fetch('/apiw/v2/copy/leader/detail?leader_id=${TEST_NUMERIC_ID}').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/api/leader/yield_curve?leader_id=${TEST_NUMERIC_ID}&cycle=month').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/leader/history_info?leader_id=${TEST_NUMERIC_ID}').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/leader/portfolio/detail?leader_id=${TEST_NUMERIC_ID}').then(r=>r.text())`,
    `fetch('/api/copytrade/copy_trading/leader/detail?leader_id=${TEST_NUMERIC_ID}').then(r=>r.text())`,
    `fetch('/api/copytrade/copy_trading/trader/detail?trader_id=${TEST_NUMERIC_ID}').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/trader/detail?trader_id=${TEST_NUMERIC_ID}').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/leader/profile?leader_id=${TEST_NUMERIC_ID}').then(r=>r.text())`,
  ]
  
  for (const apiTest of apiTests) {
    const endpointMatch = apiTest.match(/fetch\('([^']+)/)
    const endpoint = endpointMatch ? endpointMatch[1].split('?')[0] : 'unknown'
    try {
      const result = await detailPage2.evaluate(async (code) => {
        try {
          const result = await eval(code)
          return { text_preview: result.slice(0, 150), len: result.length }
        } catch(e) { return { error: e.message } }
      }, apiTest)
      const hasMdd = result.text_preview && /drawdown|retrace/i.test(result.text_preview)
      const isError = result.text_preview && (result.text_preview.includes('"code":1') || result.text_preview.includes('"code":-1') || result.text_preview.startsWith('<'))
      console.log(`  ${endpoint}: len=${result.len} mdd=${hasMdd} err=${isError} | ${result.text_preview?.slice(0, 80)}`)
    } catch (e) {
      console.log(`  ${endpoint}: EXCEPTION ${e.message}`)
    }
    await sleep(300)
  }
  await detailPage2.close()

  // Test E: CTA trader API probing - look for hidden MDD fields
  console.log('\n=== Test E: CTA detailed API probe ===')
  const ctaDetailPage = await context.newPage()
  await ctaDetailPage.goto(`https://www.gate.com/copytrading/trader/${TEST_CTA}`, {
    waitUntil: 'domcontentloaded', timeout: 20000
  }).catch(() => {})
  await sleep(2000)
  
  // Try specific endpoints for CTA trader
  const ctaApiTests = [
    `fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT&trader_name=${TEST_CTA}').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/api/leader/yield_curve?trader_name=${TEST_CTA}&cycle=month').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/api/leader/yield_curve?nickname=${TEST_CTA}&cycle=month').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/leader/cta/detail?nickname=${TEST_CTA}').then(r=>r.text())`,
    `fetch('/apiw/v2/copy/leader/cta_detail?trader_name=${TEST_CTA}').then(r=>r.text())`,
  ]
  
  for (const apiTest of ctaApiTests) {
    const endpointMatch = apiTest.match(/fetch\('([^']+)/)
    const endpoint = endpointMatch ? endpointMatch[1].split('?')[0] : 'unknown'
    try {
      const result = await ctaDetailPage.evaluate(async (code) => {
        try {
          const result = await eval(code)
          return { text_preview: result.slice(0, 200), len: result.length }
        } catch(e) { return { error: e.message } }
      }, apiTest)
      console.log(`  ${endpoint}: len=${result.len} | ${result.text_preview?.slice(0, 100)}`)
    } catch(e) {
      console.log(`  ${endpoint}: EXCEPTION ${e.message}`)
    }
    await sleep(300)
  }
  
  // Get the actual API calls made on CTA detail page
  await ctaDetailPage.close()
  
  // Test F: Full CTA API strategy_profit_list - how long can it be?
  console.log('\n=== Test F: CTA strategy_profit_list length & MDD computation ===')
  const ctaProfit = await page.evaluate(async (cta) => {
    try {
      // Search for this specific CTA trader
      for (let pg = 1; pg <= 200; pg++) {
        const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT`)
        const j = await r.json()
        if (!j?.data?.list?.length) break
        for (const t of j.data.list) {
          if ((t.nickname || '').toLowerCase() === cta.toLowerCase() ||
              (t.nick || '').toLowerCase() === cta.toLowerCase()) {
            return {
              found: true,
              nickname: t.nickname,
              page: pg,
              strategy_profit_list_len: t.strategy_profit_list?.length,
              sample: t.strategy_profit_list?.slice(0, 3),
              all_keys: Object.keys(t),
              mdd_related: Object.entries(t).filter(([k]) => /drawdown|mdd|retrace|risk|loss/i.test(k))
            }
          }
        }
      }
      return { found: false }
    } catch(e) { return { error: e.message } }
  }, TEST_CTA)
  console.log('CTA trader profile:', JSON.stringify(ctaProfit, null, 2))
  
  // Test G: Try searching ALL CTA traders pages for our missing ones
  console.log('\n=== Test G: Search all CTA pages for missing targets ===')
  const ctaFound = await page.evaluate(async (targets) => {
    const found = {}
    for (let pg = 1; pg <= 200; pg++) {
      const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT`)
      const j = await r.json()
      if (!j?.data?.list?.length) break
      for (const t of j.data.list) {
        const nick = (t.nickname || t.nick || '').toLowerCase()
        for (const target of targets) {
          if (nick === target || nick.replace(/\s+/g, '') === target || nick.startsWith(target) || target.startsWith(nick)) {
            const spList = t.strategy_profit_list || []
            // Compute MDD from profit_rate series
            const rates = spList.map(d => parseFloat(d.profit_rate || 0)).reverse()
            let peak = -Infinity, mdd = 0
            for (const r of rates) {
              if (r > peak) peak = r
              const dd = (peak - r) / (1 + peak / 100) * 100
              if (dd > mdd) mdd = dd
            }
            // Win rate: % of days positive
            let wins = 0, total = 0
            for (let i = 1; i < spList.length; i++) {
              const prev = parseFloat(spList[i].profit_rate || 0)
              const cur = parseFloat(spList[i-1].profit_rate || 0)
              total++
              if (cur > prev) wins++
            }
            const wr = total > 0 ? (wins / total) * 100 : null
            found[target] = { nick, mdd, wr, list_len: spList.length, page: pg }
            break
          }
        }
      }
      if (Object.keys(found).length === targets.length) break
    }
    return found
  }, CTA_IDS)
  
  console.log('CTA search results:', JSON.stringify(ctaFound, null, 2))
  const foundCount = Object.keys(ctaFound).length
  console.log(`\nFound ${foundCount}/${CTA_IDS.length} CTA traders via strategy_profit_list`)

  await browser.close()
  console.log('\n=== Deep Probe Complete ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })

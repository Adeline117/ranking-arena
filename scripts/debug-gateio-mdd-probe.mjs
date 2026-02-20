#!/usr/bin/env node
/**
 * Debug script: probe Gate.io API for specific traders missing MDD
 * Tests multiple endpoints to find where MDD data lives
 */
import { chromium } from 'playwright'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const NUMERIC_IDS = ['21597','20591','21601','24943','21654','25159','19108','15696','25037','21656','25217','25007','25286','24982','19681','24886','24834','16758','25239','23553','21602','21309','21651','21634','25072','20734','24318','25212','23322','25093','8921','21645','18665','24831','25002','11422','20740','25014','25117','25025','24998','22394','25062','24430','25113','25125','24991','24426','9526','25103','25156','20680','24781']

const CTA_IDS = ['cta_galaxyquant','cta_rosesneverpanic','cta_gateuser0eec98f2','cta_gateuserc864817e','cta_gateuser6ed1d847','cta_gateuserbfda99d2','cta_gateuser061f1d13','cta_gateusera1af57c1','cta_gateuser947625fb','cta_abluk24','cta_gateuser96a07d2e','cta_loaitrx','cta_gateuser19f45b51','cta_studen','cta_gateuserd2e4499f','cta_gateuserca120d12','cta_slowisfast','cta_zhaocaiqi','cta_gateuser3893dd1b']

async function main() {
  console.log('=== Gate.io MDD Probe ===\n')

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  
  console.log('Navigating to gate.com/copytrading...')
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('Session established\n')

  // Test 1: detail API for a few numeric IDs
  console.log('=== Test 1: /apiw/v2/copy/leader/detail ===')
  for (const id of NUMERIC_IDS.slice(0, 5)) {
    const result = await page.evaluate(async (leaderId) => {
      try {
        const r = await fetch(`/apiw/v2/copy/leader/detail?leader_id=${leaderId}`, {credentials: 'include'})
        const j = await r.json()
        return { status: r.status, code: j?.code, data_keys: j?.data ? Object.keys(j.data) : null, data: j?.data }
      } catch(e) { return { error: e.message } }
    }, id)
    console.log(`ID ${id}:`, JSON.stringify(result))
    await sleep(200)
  }

  // Test 2: Full leader/list with all statuses for a specific trader search
  console.log('\n=== Test 2: leader/list with trader_id filter ===')
  for (const id of NUMERIC_IDS.slice(0, 3)) {
    const result = await page.evaluate(async (leaderId) => {
      try {
        // Try searching with trader_name = leaderId (some APIs support this)
        const r = await fetch(`/apiw/v2/copy/leader/list?page=1&page_size=20&leader_id=${leaderId}`)
        const j = await r.json()
        if (j?.data?.list?.length > 0) {
          const t = j.data.list[0]
          return { found: true, win_rate: t.win_rate, max_drawdown: t.max_drawdown, keys: Object.keys(t) }
        }
        return { found: false, code: j?.code, msg: j?.message }
      } catch(e) { return { error: e.message } }
    }, id)
    console.log(`ID ${id} leader_id filter:`, JSON.stringify(result))
    await sleep(200)
  }

  // Test 3: Try individual trader page and intercept APIs
  console.log('\n=== Test 3: Individual trader page intercept ===')
  const testId = NUMERIC_IDS[0]
  const apiCalls = []
  const capturedMdd = new Map()
  
  // Intercept all responses on a test page
  const detailPage = await context.newPage()
  detailPage.on('response', async (res) => {
    const url = res.url()
    if (res.status() !== 200) return
    if (!url.includes('gate') && !url.includes('copy') && !url.includes('leader') && !url.includes('trader')) return
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const j = await res.json()
      if (!j) return
      // Extract raw JSON data
      const str = JSON.stringify(j)
      if (str.includes('max_drawdown') || str.includes('drawdown') || str.includes('retrace')) {
        apiCalls.push({ url: url.slice(-100), code: j?.code })
        // Walk to find max_drawdown
        function findField(obj, depth = 0) {
          if (!obj || typeof obj !== 'object' || depth > 5) return
          for (const [k, v] of Object.entries(obj)) {
            if (/drawdown|retrace|mdd/i.test(k)) {
              capturedMdd.set(url.slice(-80), { field: k, value: v, from_id: testId })
            }
            if (typeof v === 'object') findField(v, depth + 1)
          }
        }
        findField(j)
      }
    } catch {}
  })
  
  await detailPage.goto(`https://www.gate.com/copytrading/trader/${testId}`, {
    waitUntil: 'networkidle', timeout: 20000
  }).catch(() => {})
  await sleep(3000)
  console.log(`Trader ${testId} detail page APIs with drawdown:`)
  for (const [url, data] of capturedMdd) {
    console.log(`  URL: ...${url}`)
    console.log(`  Field: ${data.field} = ${data.value}`)
  }
  if (apiCalls.length === 0) console.log('  No drawdown fields found in any API response!')
  await detailPage.close()

  // Test 4: Try different API variants for leader detail
  console.log('\n=== Test 4: Alternative leader detail endpoints ===')
  const endpoints = [
    (id) => `/apiw/v2/copy/leader/detail?leader_id=${id}`,
    (id) => `/apiw/v2/copy/leader/detail?leader_id=${id}&cycle=month`,
    (id) => `/apiw/v2/copy/leader/overview?leader_id=${id}`,
    (id) => `/apiw/v2/copy/leader/performance?leader_id=${id}`,
    (id) => `/apiw/v2/copy/leader/stats?leader_id=${id}`,
    (id) => `/apiw/v2/copytrade/leader/detail?leader_id=${id}`,
    (id) => `/apiw/v2/copy/leader/history?leader_id=${id}&page=1&page_size=10`,
    (id) => `/apiw/v2/copy/profit/leader?leader_id=${id}&cycle=month`,
  ]
  
  for (const endpointFn of endpoints) {
    const url = endpointFn(NUMERIC_IDS[0])
    const result = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, {credentials: 'include'})
        const j = await r.json()
        const str = JSON.stringify(j)
        const hasMdd = str.includes('drawdown') || str.includes('retrace')
        return { status: r.status, code: j?.code, hasMdd, msg: j?.message?.slice(0, 50) }
      } catch(e) { return { error: e.message } }
    }, url)
    console.log(`  ${url.split('?')[0]}: status=${result.status} code=${result.code} hasMdd=${result.hasMdd} msg=${result.msg}`)
    await sleep(300)
  }

  // Test 5: Full list pagination - check how many pages total and if our traders appear
  console.log('\n=== Test 5: How many pages in leader/list? ===')
  for (const cycle of ['week', 'month', 'quarter']) {
    const result = await page.evaluate(async (cycle) => {
      try {
        const r = await fetch(`/apiw/v2/copy/leader/list?page=1&page_size=100&cycle=${cycle}&order_by=profit_rate&sort_by=desc`)
        const j = await r.json()
        return { code: j?.code, total: j?.data?.total_count || j?.data?.totalcount, list_len: j?.data?.list?.length }
      } catch(e) { return { error: e.message } }
    }, cycle)
    console.log(`  cycle=${cycle}: total=${result.total} page_size=100 list_len=${result.list_len}`)
    await sleep(200)
  }

  // Test 6: Check if there's a "stopped" or "all" status filter 
  console.log('\n=== Test 6: leader/list with status=stopped ===')
  for (const status of ['', 'running', 'stopped', 'paused', 'all']) {
    const result = await page.evaluate(async (status) => {
      try {
        const url = `/apiw/v2/copy/leader/list?page=1&page_size=100&cycle=month&order_by=profit_rate&sort_by=desc${status ? '&status=' + status : ''}`
        const r = await fetch(url)
        const j = await r.json()
        // Check if any of our target IDs appear
        const list = j?.data?.list || []
        const found = list.filter(t => ['21597','20591','21601','24943','21654'].includes(String(t.leader_id || '')))
        return { code: j?.code, total: j?.data?.total_count || j?.data?.totalcount, list_len: list.length, found_targets: found.length }
      } catch(e) { return { error: e.message } }
    }, status)
    console.log(`  status="${status}": total=${result.total} found_targets=${result.found_targets}`)
    await sleep(200)
  }

  // Test 7: CTA - check what the query_cta_trader API returns
  console.log('\n=== Test 7: CTA API check ===')
  const ctaResult = await page.evaluate(async () => {
    try {
      const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT')
      const j = await r.json()
      if (!j?.data?.list?.length) return { code: j?.code, len: 0 }
      const t = j.data.list[0]
      return {
        code: j?.code,
        totalcount: j?.data?.totalcount,
        pagecount: j?.data?.pagecount,
        sample_keys: Object.keys(t),
        has_drawdown: JSON.stringify(t).includes('drawdown'),
        has_strategy_profit: !!t.strategy_profit_list,
        strategy_profit_sample: t.strategy_profit_list?.slice(0, 2),
        sample_mdd_fields: Object.entries(t).filter(([k]) => /drawdown|retrace|mdd|risk/i.test(k)).map(([k,v]) => ({k,v}))
      }
    } catch(e) { return { error: e.message } }
  })
  console.log('CTA API result:', JSON.stringify(ctaResult, null, 2))
  
  // Test 8: Try individual cta trader profile  
  console.log('\n=== Test 8: CTA trader detail page ===')
  const ctaTestUsername = CTA_IDS[0].replace('cta_', '')
  const ctaDetailPage = await context.newPage()
  const ctaApiCalls = []
  
  ctaDetailPage.on('response', async (res) => {
    const url = res.url()
    if (res.status() !== 200) return
    try {
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      if (!url.includes('gate') || (!url.includes('copy') && !url.includes('cta') && !url.includes('leader'))) return
      const j = await res.json()
      if (j?.code !== 0 && j?.code !== undefined) return
      const str = JSON.stringify(j)
      if (str.length < 50) return
      ctaApiCalls.push({ url: url.slice(-100), keys_top: j?.data ? Object.keys(j.data).slice(0, 10) : null, hasMdd: /drawdown|retrace/i.test(str) })
    } catch {}
  })
  
  await ctaDetailPage.goto(`https://www.gate.com/copytrading/trader/${ctaTestUsername}`, {
    waitUntil: 'networkidle', timeout: 20000
  }).catch(() => {})
  await sleep(3000)
  console.log(`CTA trader "${ctaTestUsername}" detail page APIs:`)
  for (const call of ctaApiCalls) {
    console.log(`  URL: ...${call.url}`)
    console.log(`  data keys: ${call.keys_top?.join(', ')}`)
    console.log(`  hasMdd: ${call.hasMdd}`)
  }
  await ctaDetailPage.close()

  await browser.close()
  console.log('\n=== Probe complete ===')
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })

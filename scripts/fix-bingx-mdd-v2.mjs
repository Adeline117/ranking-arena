#!/usr/bin/env node
/**
 * BingX MDD Fix v2
 * 
 * Key insight: page.evaluate fetch results must be RETURNED from evaluate,
 * not intercepted via page.on('response'). The response listener doesn't 
 * capture fetch() calls made inside page.evaluate.
 * 
 * Also: after initial headers expire, we click UI elements to trigger new signed requests,
 * and intercept THOSE via the response listener.
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')

function parseMDD(v) {
  if (v == null || v === '--' || v === '') return null
  const f = parseFloat(String(v).replace('%', '').replace('-', '').trim())
  if (isNaN(f) || f < 0) return null
  if (f > 0 && f <= 1) return Math.round(f * 10000) / 100
  return Math.round(Math.abs(f) * 100) / 100
}

function parseWR(v) {
  if (v == null || v === '--') return null
  const f = parseFloat(String(v).replace('%', '').trim())
  if (isNaN(f)) return null
  if (f > 0 && f <= 1) return Math.round(f * 10000) / 100
  return Math.round(f * 100) / 100
}

function calcMddFromChart(chart) {
  if (!Array.isArray(chart) || chart.length < 2) return null
  const equities = chart.map(p => 1 + parseFloat(p.cumulativePnlRate || p.pnlRate || 0))
  let peak = equities[0], maxDD = 0
  for (const eq of equities) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = (peak - eq) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0.0001 ? Math.round(maxDD * 10000) / 100 : null
}

function extractFromStat(stat) {
  if (!stat) return {}
  // MDD: try all possible field names
  const mddCandidates = [
    stat.maxDrawDown90d, stat.maxDrawdown90d, stat.maximumDrawDown90d,
    stat.maxDrawDown30d, stat.maxDrawDown7d, stat.maxDrawDown180d,
    stat.maxDrawdown, stat.maxDrawDown, stat.maximumDrawDown,
    stat.mdd, stat.drawdown,
  ]
  let mdd = null
  for (const c of mddCandidates) {
    const m = parseMDD(c)
    if (m != null) { mdd = m; break }
  }
  if (mdd == null) mdd = calcMddFromChart(stat.chart || stat.pnlChart)
  
  const wr = parseWR(stat.winRate90d ?? stat.winRate ?? stat.winRate30d ?? stat.win_rate)
  const tc = stat.totalTransactions != null ? parseInt(stat.totalTransactions) : null
  return { wr, mdd, tc }
}

async function main() {
  console.log('🚀 BingX MDD Fix v2')
  if (DRY_RUN) console.log('   [DRY RUN]\n')

  // Fetch null rows
  const { data: bingxRows } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)
  const bingxUIDs = [...new Set((bingxRows || []).map(r => r.source_trader_id))]
  console.log(`bingx MDD null: ${bingxRows.length} rows, ${bingxUIDs.length} unique UIDs`)

  const { data: spotRows } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')
  const spotTraderIds = [...new Set((spotRows || []).map(r => r.source_trader_id))]
  console.log(`bingx_spot null: ${spotRows.length} rows, ${spotTraderIds.length} unique trader IDs`)

  // Launch browser
  console.log('\n🎭 Launching Playwright...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()
  const futuresMap = new Map()
  const spotMap = new Map()

  // ── Capture headers via CDP ──────────────────────────────────────────
  let capturedFuturesHeaders = null
  let capturedBody = null
  let capturedSpotHeaders = null
  let capturedSpotBody = null
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.method !== 'POST') return
    if (request.url.includes('copy-trade-facade/v2/trader/new/recommend') || request.url.includes('copy-trade-facade/v2/trader/ranking')) {
      if (!capturedFuturesHeaders) {
        capturedFuturesHeaders = request.headers
        try { capturedBody = JSON.parse(request.postData || '{}') } catch {}
        console.log('  ✅ Futures headers captured')
      }
    }
    if (request.url.includes('spot/trader/search') || request.url.includes('spot/trader/recommend')) {
      if (!capturedSpotHeaders) {
        capturedSpotHeaders = request.headers
        try { capturedSpotBody = JSON.parse(request.postData || '{}') } catch {}
        console.log('  ✅ Spot headers captured')
      }
    }
  })

  // ALSO intercept natural page responses (from UI clicks)
  page.on('response', async resp => {
    const url = resp.url()
    try {
      if (url.includes('copy-trade-facade/v2/trader/new/recommend') || url.includes('copy-trade-facade/v2/trader/ranking')) {
        const json = await resp.json().catch(() => null)
        if (!json?.data?.result?.length) return
        for (const item of json.data.result) {
          const uid = String(item.trader?.uid || item.uid || '')
          if (!uid) continue
          const stat = item.rankStat || {}
          const { wr, mdd, tc } = extractFromStat(stat)
          if (wr != null || mdd != null) {
            futuresMap.set(uid, { wr, mdd, tc })
            if (bingxUIDs.includes(uid)) console.log(`  🎯 Got target UID ${uid}: MDD=${mdd}`)
          }
        }
      }
      if (url.includes('spot/trader/search') || url.includes('spot/trader/recommend')) {
        const json = await resp.json().catch(() => null)
        const items = json?.data?.result || []
        for (const item of items) {
          const traderInfo = item.trader || {}
          const uid = String(traderInfo.uid || traderInfo.uniqueId || '')
          const nick = traderInfo.nickName || traderInfo.nickname || traderInfo.traderName || ''
          const stat = item.rankStat || {}
          const { wr, mdd, tc } = extractFromStat(stat)
          if (wr != null || mdd != null) {
            if (uid && uid !== '0') spotMap.set(uid, { wr, mdd, tc, nick })
            if (nick) {
              const slug = nick.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
              spotMap.set(slug, { wr, mdd, tc, nick })
            }
          }
        }
      }
    } catch {}
  })

  // ── 1. Load Futures Copy Trading ─────────────────────────────────────
  console.log('\n🌐 Loading BingX futures copy trading...')
  await page.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => console.log('  timeout'))
  await sleep(5000)

  const initialCount = futuresMap.size
  console.log(`  Initial traders from page load: ${initialCount}`)

  // ── 2. Paginate Futures Recommend API (return results from evaluate) ──
  if (capturedFuturesHeaders) {
    // First determine total
    const firstResult = await page.evaluate(async ({ url, headers, body }) => {
      try {
        const r = await fetch(`${url}?pageId=0&pageSize=12`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, pageId: 0, pageSize: 12 })
        })
        return await r.json()
      } catch (e) { return { error: e.message } }
    }, { url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend', headers: capturedFuturesHeaders, body: capturedBody || {} })

    if (firstResult?.code === 0) {
      const total = firstResult.data?.total || 12
      const pageSize = firstResult.data?.result?.length || 12
      const numPages = Math.ceil(total / pageSize)
      console.log(`\n📡 Futures recommend: total=${total}, pageSize=${pageSize}, pages=${numPages}`)
      
      // Process page 0 results
      for (const item of firstResult.data?.result || []) {
        const uid = String(item.trader?.uid || '')
        if (!uid) continue
        const { wr, mdd, tc } = extractFromStat(item.rankStat || {})
        if (wr != null || mdd != null) futuresMap.set(uid, { wr, mdd, tc })
      }

      // Paginate remaining pages
      for (let p = 1; p < numPages; p++) {
        const result = await page.evaluate(async ({ url, headers, body, pageId, pageSize }) => {
          try {
            const r = await fetch(`${url}?pageId=${pageId}&pageSize=${pageSize}`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ ...body, pageId, pageSize })
            })
            return await r.json()
          } catch (e) { return { error: e.message } }
        }, { url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend', headers: capturedFuturesHeaders, body: capturedBody || {}, pageId: p, pageSize })
        
        if (result?.error || result?.code !== 0) {
          console.log(`  Page ${p}: code=${result?.code} error=${result?.error || ''}`)
          break
        }
        for (const item of result.data?.result || []) {
          const uid = String(item.trader?.uid || '')
          if (!uid) continue
          const { wr, mdd, tc } = extractFromStat(item.rankStat || {})
          if (wr != null || mdd != null) {
            futuresMap.set(uid, { wr, mdd, tc })
            if (bingxUIDs.includes(uid)) console.log(`  🎯 Found target ${uid}: MDD=${mdd}`)
          }
        }
        if (p % 5 === 0) console.log(`  Page ${p}/${numPages}: collected ${futuresMap.size} traders`)
        await sleep(300)
      }
    } else {
      console.log(`  Recommend API: code=${firstResult?.code} error=${firstResult?.error}`)
      // Try without body
      const r2 = await page.evaluate(async ({ headers }) => {
        try {
          const r = await fetch('https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=0&pageSize=12', {
            method: 'POST',
            headers,
            credentials: 'include'
          })
          return await r.json()
        } catch (e) { return { error: e.message } }
      }, { headers: capturedFuturesHeaders })
      console.log(`  No-body: code=${r2?.code} total=${r2?.data?.total}`)
    }

    // Also try with different sortTypes
    const stillMissingBingx = bingxUIDs.filter(uid => !futuresMap.has(uid))
    if (stillMissingBingx.length > 0) {
      console.log(`\n  Still missing: ${stillMissingBingx.length}. Trying sortTypes...`)
      for (const sortType of [1, 2, 3, 4, 5]) {
        const result = await page.evaluate(async ({ url, headers, body, sortType }) => {
          try {
            const r = await fetch(`${url}?pageId=0&pageSize=50`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ ...body, sortType, pageId: 0, pageSize: 50 })
            })
            return await r.json()
          } catch (e) { return { error: e.message } }
        }, { url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend', headers: capturedFuturesHeaders, body: capturedBody || {}, sortType })
        
        if (result?.code === 0) {
          const total = result.data?.total || 0
          const pageSize2 = result.data?.result?.length || 50
          const numPages2 = Math.ceil(total / pageSize2)
          console.log(`  sortType=${sortType}: total=${total}`)
          
          for (let p = 0; p < numPages2; p++) {
            const pResult = p === 0 ? result : await page.evaluate(async ({ url, headers, body, sortType, pageId, pageSize }) => {
              try {
                const r = await fetch(`${url}?pageId=${pageId}&pageSize=${pageSize}`, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({ ...body, sortType, pageId, pageSize })
                })
                return await r.json()
              } catch (e) { return { error: e.message } }
            }, { url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend', headers: capturedFuturesHeaders, body: capturedBody || {}, sortType, pageId: p, pageSize: pageSize2 })
            
            if (!pResult?.data?.result?.length) break
            for (const item of pResult.data.result) {
              const uid = String(item.trader?.uid || '')
              if (!uid) continue
              const { wr, mdd, tc } = extractFromStat(item.rankStat || {})
              if (wr != null || mdd != null) {
                futuresMap.set(uid, { wr, mdd, tc })
                if (bingxUIDs.includes(uid)) console.log(`  🎯 Found target ${uid} via sortType=${sortType}: MDD=${mdd}`)
              }
            }
            await sleep(300)
          }
        }
      }
    }
  }

  // ── 3. Click UI to get more futures data ─────────────────────────────
  const stillMissing = bingxUIDs.filter(uid => !futuresMap.has(uid))
  if (stillMissing.length > 0) {
    console.log(`\n🖱 Clicking UI tabs to discover more traders (${stillMissing.length} still missing)...`)
    
    // Try clicking different time period tabs
    for (const tab of ['7D', '30D', '90D', '180D']) {
      try {
        const el = page.locator(`text="${tab}"`).first()
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          await el.click()
          await sleep(3000)
          console.log(`  After ${tab} tab: ${futuresMap.size} traders`)
        }
      } catch {}
    }

    // Try scrolling to trigger infinite scroll
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
    }
    console.log(`  After scroll: ${futuresMap.size} traders`)
  }

  // ── 4. Individual Futures Traders via Search ─────────────────────────
  const stillMissing2 = bingxUIDs.filter(uid => !futuresMap.has(uid))
  if (stillMissing2.length > 0) {
    console.log(`\n🔍 Searching ${stillMissing2.length} individual futures traders via BingX search API...`)
    for (const uid of stillMissing2) {
      // Try multiple search endpoints
      const result = await page.evaluate(async ({ uid }) => {
        const endpoints = [
          `https://bingx.com/api/copytrading/v1/trader/search?keyword=${uid}`,
          `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}&timeType=3`,
          `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}`,
          `https://bingx.com/api/copytrading/v1/trader/analysis?uid=${uid}&timeType=3`,
          `https://bingx.com/api/strategy/api/v1/copy/trader/detail?uid=${uid}`,
        ]
        for (const url of endpoints) {
          try {
            const r = await fetch(url, { credentials: 'include' })
            if (!r.ok) continue
            const json = await r.json()
            if (json?.code === 0 && json?.data) return { url, data: json.data }
            // Also check for array response
            if (Array.isArray(json?.data) && json.data.length > 0) return { url, data: json.data[0] }
          } catch {}
        }
        return null
      }, { uid }).catch(() => null)

      if (result?.data) {
        const d = result.data
        const stat = d.rankStat || d
        const { wr, mdd, tc } = extractFromStat(stat)
        if (wr != null || mdd != null) {
          futuresMap.set(uid, { wr, mdd, tc })
          console.log(`  ✓ UID ${uid}: MDD=${mdd} (via ${result.url.split('/').slice(-2).join('/')})`)
        } else {
          console.log(`  ! UID ${uid}: found but no MDD data (keys: ${Object.keys(d).join(',').slice(0, 80)})`)
        }
      }
      await sleep(300)
    }
  }

  console.log(`\n  Final futures collected: ${futuresMap.size} traders`)
  const finalMissingBingx = bingxUIDs.filter(uid => !futuresMap.has(uid) || futuresMap.get(uid).mdd == null)
  console.log(`  Still missing MDD for bingx: ${finalMissingBingx.length}`)
  if (finalMissingBingx.length > 0 && finalMissingBingx.length <= 10) {
    console.log(`  Missing UIDs: ${finalMissingBingx.join(', ')}`)
  }

  // ── 5. Load BingX Spot ───────────────────────────────────────────────
  console.log('\n🌐 Loading BingX spot copy trading...')
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => console.log('  timeout'))
  await sleep(6000)
  
  const spotHandles = spotRows.map(r => r.handle)
  console.log(`  After spot page load: ${spotMap.size} spot traders`)

  // ── 6. Paginate Spot API ─────────────────────────────────────────────
  if (capturedSpotHeaders) {
    console.log('\n📡 Paginating spot search API...')
    const spotApiUrl = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'
    
    // Try multiple sort types for spot
    for (const sortType of [0, 1, 2, 3, 4, 5]) {
      const spotTotal = await page.evaluate(async ({ url, headers, body, sortType }) => {
        try {
          const r = await fetch(`${url}?pageId=0&pageSize=20`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, sortType, pageId: 0, pageSize: 20 })
          })
          const json = await r.json()
          return json
        } catch (e) { return { error: e.message } }
      }, { url: spotApiUrl, headers: capturedSpotHeaders, body: capturedSpotBody || {}, sortType })
      
      if (!spotTotal || spotTotal.code !== 0) continue
      const total = spotTotal.data?.total || 0
      const numPages = Math.ceil(total / 20)
      if (sortType === 0) console.log(`  Spot API: total=${total}, pages=${numPages}`)
      
      // Process page 0
      for (const item of spotTotal.data?.result || []) {
        const traderInfo = item.trader || {}
        const nick = traderInfo.nickName || traderInfo.nickname || traderInfo.traderName || ''
        const uid = String(traderInfo.uid || '')
        const { wr, mdd, tc } = extractFromStat(item.rankStat || {})
        if (wr != null || mdd != null) {
          const slug = nick.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
          if (slug) spotMap.set(slug, { wr, mdd, tc, nick })
          if (uid && uid !== '0') spotMap.set(uid, { wr, mdd, tc, nick })
        }
      }

      // Paginate
      for (let p = 1; p < Math.min(numPages, 50); p++) {
        const result = await page.evaluate(async ({ url, headers, body, sortType, p }) => {
          try {
            const r = await fetch(`${url}?pageId=${p}&pageSize=20`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ ...body, sortType, pageId: p, pageSize: 20 })
            })
            return await r.json()
          } catch (e) { return { error: e.message } }
        }, { url: spotApiUrl, headers: capturedSpotHeaders, body: capturedSpotBody || {}, sortType, p })
        
        if (!result?.data?.result?.length) break
        for (const item of result.data.result) {
          const traderInfo = item.trader || {}
          const nick = traderInfo.nickName || traderInfo.nickname || traderInfo.traderName || ''
          const uid = String(traderInfo.uid || '')
          const { wr, mdd, tc } = extractFromStat(item.rankStat || {})
          if (wr != null || mdd != null) {
            const slug = nick.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
            if (slug) spotMap.set(slug, { wr, mdd, tc, nick })
            if (uid && uid !== '0') spotMap.set(uid, { wr, mdd, tc, nick })
          }
        }
        await sleep(300)
      }
      console.log(`  sortType=${sortType}: spot map size=${Math.floor(spotMap.size / 2)}`)
    }
  }

  // ── 7. Search for individual missing spot traders ─────────────────────
  const missingSpotTraders = spotRows.filter(r => {
    const tid = r.source_trader_id
    const hslug = (r.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    return !spotMap.has(tid) && !spotMap.has(hslug)
  })
  
  const uniqueMissingSpot = [...new Map(missingSpotTraders.map(r => [r.source_trader_id, r])).values()]
  
  if (uniqueMissingSpot.length > 0 && capturedSpotHeaders) {
    console.log(`\n🔍 Searching ${uniqueMissingSpot.length} missing spot traders...`)
    for (const row of uniqueMissingSpot) {
      const handle = row.handle || ''
      const spotApiUrl = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'
      
      const result = await page.evaluate(async ({ url, headers, body, handle }) => {
        const bodies = [
          { keyword: handle, pageId: 0, pageSize: 10 },
          { nickName: handle, pageId: 0, pageSize: 10 },
        ]
        for (const b of bodies) {
          try {
            const r = await fetch(`${url}?pageId=0&pageSize=10&keyword=${encodeURIComponent(handle)}`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ ...body, ...b })
            })
            const json = await r.json()
            if (json?.code === 0 && json?.data?.result?.length > 0) return json.data.result
          } catch {}
        }
        return null
      }, { url: spotApiUrl, headers: capturedSpotHeaders, body: capturedSpotBody || {}, handle }).catch(() => null)

      if (result?.length > 0) {
        for (const item of result) {
          const traderInfo = item.trader || {}
          const nick = traderInfo.nickName || ''
          const { wr, mdd, tc } = extractFromStat(item.rankStat || {})
          if (wr != null || mdd != null) {
            spotMap.set(row.source_trader_id, { wr, mdd, tc, nick })
            const hslug = handle.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
            spotMap.set(hslug, { wr, mdd, tc, nick })
            console.log(`  ✓ ${handle}: WR=${wr} MDD=${mdd}`)
          }
        }
      } else {
        console.log(`  ✗ ${handle}: not found`)
      }
      await sleep(400)
    }
  }

  await browser.close()
  console.log('\n✅ Browser closed')
  console.log(`  futuresMap: ${futuresMap.size} entries`)
  console.log(`  spotMap: ${spotMap.size} entries`)

  // ── 8. Update DB ─────────────────────────────────────────────────────
  console.log('\n📝 Updating database...')

  // Update bingx leaderboard_ranks
  let bingxUpdated = 0
  for (const row of (bingxRows || [])) {
    const d = futuresMap.get(row.source_trader_id)
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (DRY_RUN) { console.log(`  [DRY] bingx ${row.id} (${row.handle}): ${JSON.stringify(updates)}`); bingxUpdated++; continue }
    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) bingxUpdated++
    else console.error(`  Error ${row.id}: ${error.message}`)
  }

  // Update trader_snapshots for bingx
  const { data: snapBingx } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)
  let snapBingxUpdated = 0
  for (const row of (snapBingx || [])) {
    const d = futuresMap.get(row.source_trader_id)
    if (!d?.mdd) continue
    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots').update({ max_drawdown: d.mdd }).eq('id', row.id)
      if (!error) snapBingxUpdated++
    } else snapBingxUpdated++
  }

  // Update bingx_spot leaderboard_ranks
  let spotUpdated = 0
  for (const row of (spotRows || [])) {
    const tid = row.source_trader_id
    const hslug = (row.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(hslug)
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (DRY_RUN) { console.log(`  [DRY] spot ${row.id} (${row.handle}): ${JSON.stringify(updates)}`); spotUpdated++; continue }
    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) spotUpdated++
    else console.error(`  Error ${row.id}: ${error.message}`)
  }

  // Update trader_snapshots for bingx_spot
  const { data: snapSpot } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, handle, max_drawdown, win_rate')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')
  let snapSpotUpdated = 0
  for (const row of (snapSpot || [])) {
    const tid = row.source_trader_id
    const hslug = (row.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(hslug)
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) snapSpotUpdated++
    } else snapSpotUpdated++
  }

  console.log(`  leaderboard_ranks bingx: ${bingxUpdated}/${bingxRows.length}`)
  console.log(`  trader_snapshots bingx: ${snapBingxUpdated}/${snapBingx?.length || 0}`)
  console.log(`  leaderboard_ranks bingx_spot: ${spotUpdated}/${spotRows.length}`)
  console.log(`  trader_snapshots bingx_spot: ${snapSpotUpdated}/${snapSpot?.length || 0}`)

  // ── 9. Final Verification ─────────────────────────────────────────────
  console.log('\n📊 Final null counts:')
  for (const source of ['bingx', 'bingx_spot']) {
    for (const tbl of ['leaderboard_ranks', 'trader_snapshots']) {
      const { count: total } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source)
      const { count: mddNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('max_drawdown', null)
      const { count: wrNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('win_rate', null)
      console.log(`  ${tbl} '${source}': total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)
    }
  }
  console.log('\n✅ Done!')
}

main().catch(e => { console.error(e); process.exit(1) })

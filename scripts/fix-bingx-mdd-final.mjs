#!/usr/bin/env node
/**
 * BingX MDD/WR Fix - Final
 * 
 * Targets:
 *   - leaderboard_ranks source='bingx': 46 rows with max_drawdown=null
 *   - leaderboard_ranks source='bingx_spot': 36 MDD null, 3 WR null
 * 
 * Approach:
 *   1. Launch Playwright, get CF cookies from BingX
 *   2. bingx futures: paginate recommend API, then individual trader detail pages
 *   3. bingx_spot: paginate spot search API, then individual spot trader pages
 *   4. Update DB only with real API data (NO fabrication)
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')

// ─── Parsers ───────────────────────────────────────────────────────────
function parseWR(v) {
  if (v == null || v === '--') return null
  const f = parseFloat(String(v).replace('%', '').trim())
  if (isNaN(f)) return null
  if (f > 0 && f <= 1) return Math.round(f * 10000) / 100  // 0-1 scale → percent
  return Math.round(f * 100) / 100
}

function parseMDD(v) {
  if (v == null || v === '--') return null
  const f = parseFloat(String(v).replace('%', '').replace('-', '').trim())
  if (isNaN(f)) return null
  const abs = Math.abs(f)
  if (abs > 0 && abs <= 1) return Math.round(abs * 10000) / 100
  return Math.round(abs * 100) / 100
}

function calcMddFromChart(chart) {
  if (!Array.isArray(chart) || chart.length < 2) return null
  const equities = chart.map(p => 1 + parseFloat(p.cumulativePnlRate || p.pnlRate || p.rate || 0))
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
  const wr = parseWR(
    stat.winRate90d ?? stat.winRate ?? stat.win_rate
  )
  const mddCandidates = [
    stat.maxDrawDown90d, stat.maxDrawdown90d, stat.maximumDrawDown90d,
    stat.maxDrawdown, stat.maxDrawDown, stat.maximumDrawDown,
    stat.mdd, stat.drawdown
  ]
  let mdd = null
  for (const c of mddCandidates) {
    const m = parseMDD(c)
    if (m != null) { mdd = m; break }
  }
  // try chart-based MDD
  if (mdd == null) {
    const chart = stat.chart || stat.pnlChart || stat.equityChart
    if (chart) mdd = calcMddFromChart(chart)
  }
  const tc = stat.totalTransactions != null ? parseInt(stat.totalTransactions) : null
  return { wr, mdd, tc }
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 BingX MDD Fix - Final Script')
  if (DRY_RUN) console.log('   [DRY RUN MODE]\n')

  // ── 1. Fetch null rows ──────────────────────────────────────────────
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
  console.log(`bingx_spot null: ${spotRows.length} rows, ${spotTraderIds.length} unique IDs`)

  // ── 2. Launch browser ───────────────────────────────────────────────
  console.log('\n🎭 Launching Playwright...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()
  let capturedFuturesHeaders = null
  let capturedSpotHeaders = null

  // Capture headers
  page.on('request', req => {
    const url = req.url()
    const method = req.method()
    if (method === 'POST') {
      if (url.includes('copy-trade-facade/v2/trader') || url.includes('recommend')) {
        if (!capturedFuturesHeaders) {
          capturedFuturesHeaders = Object.fromEntries(
            Object.entries(req.headers()).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))
          )
          console.log('  ✅ Futures API headers captured')
        }
      }
      if (url.includes('spot/trader') || url.includes('copy-trade-facade/v2/spot')) {
        if (!capturedSpotHeaders) {
          capturedSpotHeaders = Object.fromEntries(
            Object.entries(req.headers()).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))
          )
          console.log('  ✅ Spot API headers captured')
        }
      }
    }
  })

  // ── 3. Load BingX Futures Copy Trading ─────────────────────────────
  console.log('\n🌐 Loading BingX futures copy trading...')
  await page.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => console.log('  ⚠ Load timeout, continuing...'))
  await sleep(8000)

  // Dismiss cookie banners
  for (const text of ['Accept All', 'Accept', 'Got it', 'OK', 'Close', 'Confirm', 'I Agree']) {
    try {
      const btn = page.locator(`button:has-text("${text}")`).first()
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click().catch(() => {})
        await sleep(200)
      }
    } catch {}
  }

  // Wait for headers
  if (!capturedFuturesHeaders) {
    await page.evaluate(() => window.scrollBy(0, 1000))
    await sleep(3000)
  }
  if (!capturedFuturesHeaders) {
    console.log('  ⚠ No futures headers yet, scrolling more...')
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await sleep(2000)
    }
  }

  const futuresEnrichMap = new Map()

  // ── 4. Paginate Futures Recommend API ──────────────────────────────
  if (capturedFuturesHeaders) {
    console.log('\n📡 Paginating futures recommend API...')
    
    // Try both the standard recommend and trader/ranking APIs
    const apiEndpoints = [
      'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend',
      'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/ranking',
    ]
    
    for (const baseUrl of apiEndpoints) {
      let pagesFetched = 0
      for (let pageId = 0; pageId < 50; pageId++) {
        try {
          const result = await page.evaluate(async ({ url, headers, pageId }) => {
            const r = await fetch(`${url}?pageId=${pageId}&pageSize=50`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ pageId, pageSize: 50 })
            })
            return await r.json()
          }, { url: baseUrl, headers: capturedFuturesHeaders, pageId })

          if (!result || result.code !== 0) {
            if (pageId === 0) console.log(`  ${baseUrl.split('/').pop()}: code=${result?.code}`)
            break
          }
          const items = result?.data?.result || result?.data?.list || []
          if (!items.length) break

          for (const item of items) {
            const uid = String(item.trader?.uid || item.uid || item.traderId || '')
            if (!uid) continue
            const stat = item.rankStat || item.stat || item
            const { wr, mdd, tc } = extractFromStat(stat)
            if (wr != null || mdd != null || tc != null) {
              futuresEnrichMap.set(uid, { wr, mdd, tc })
            }
          }

          pagesFetched++
          if (pageId % 5 === 0) {
            console.log(`  page ${pageId}: collected ${futuresEnrichMap.size} traders (total=${result?.data?.total || '?'})`)
          }
          
          // Stop if we've covered the range
          if (items.length < 50) break
          await sleep(500)
        } catch (e) {
          if (pageId === 0) console.log(`  Error: ${e.message.slice(0, 80)}`)
          break
        }
      }
      console.log(`  ${baseUrl.split('/').pop()}: fetched ${pagesFetched} pages, total unique: ${futuresEnrichMap.size}`)
    }

    // Also try different sortTypes
    const sortTypes = [1, 2, 3, 4, 5]
    for (const sortType of sortTypes) {
      const stillMissing = bingxUIDs.filter(uid => !futuresEnrichMap.has(uid))
      if (stillMissing.length === 0) break
      
      for (let pageId = 0; pageId < 20; pageId++) {
        try {
          const result = await page.evaluate(async ({ url, headers, pageId, sortType }) => {
            const r = await fetch(`${url}?pageId=${pageId}&pageSize=50`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ pageId, pageSize: 50, sortType })
            })
            return await r.json()
          }, { url: 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend', headers: capturedFuturesHeaders, pageId, sortType })

          if (!result || result.code !== 0) break
          const items = result?.data?.result || []
          if (!items.length) break

          for (const item of items) {
            const uid = String(item.trader?.uid || item.uid || '')
            if (!uid) continue
            const stat = item.rankStat || {}
            const { wr, mdd, tc } = extractFromStat(stat)
            if (wr != null || mdd != null || tc != null) {
              futuresEnrichMap.set(uid, { wr, mdd, tc })
            }
          }
          if (items.length < 50) break
          await sleep(300)
        } catch { break }
      }
    }
  }

  const missingAfterRecommend = bingxUIDs.filter(uid => !futuresEnrichMap.has(uid))
  console.log(`\n  After recommend API: ${futuresEnrichMap.size} traders total`)
  console.log(`  Still missing: ${missingAfterRecommend.length}/${bingxUIDs.length}`)

  // ── 5. Individual Trader Detail Pages for Missing ───────────────────
  if (missingAfterRecommend.length > 0) {
    console.log(`\n🔍 Fetching ${missingAfterRecommend.length} individual trader detail pages...`)

    for (let i = 0; i < missingAfterRecommend.length; i++) {
      const uid = missingAfterRecommend[i]
      let detailData = null

      // Try API calls directly from page context with auth headers
      if (capturedFuturesHeaders) {
        detailData = await page.evaluate(async ({ uid, headers }) => {
          const endpoints = [
            // The recommend API might have a detail endpoint
            `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/detail?uid=${uid}`,
            `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/info?uid=${uid}`,
            `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/detail?uid=${uid}`,
          ]
          for (const url of endpoints) {
            try {
              const r = await fetch(url, {
                method: 'GET',
                headers,
                credentials: 'include'
              })
              if (!r.ok) continue
              const json = await r.json()
              if (json?.code === 0 && json?.data) return { url, data: json.data }
            } catch {}
            // Also try POST
            try {
              const r = await fetch(url.split('?')[0], {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid }),
                credentials: 'include'
              })
              if (!r.ok) continue
              const json = await r.json()
              if (json?.code === 0 && json?.data) return { url: url + '(POST)', data: json.data }
            } catch {}
          }
          
          // Also try BingX direct endpoints (with CF cookies)
          const bingxEndpoints = [
            `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}&timeType=3`,
            `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}`,
            `https://bingx.com/api/strategy/api/v1/copy/trader/detail?uid=${uid}`,
          ]
          for (const url of bingxEndpoints) {
            try {
              const r = await fetch(url, { credentials: 'include' })
              if (!r.ok) continue
              const json = await r.json()
              if (json?.code === 0 && json?.data) return { url, data: json.data }
            } catch {}
          }
          return null
        }, { uid, headers: capturedFuturesHeaders }).catch(() => null)
      }

      if (detailData?.data) {
        const { wr, mdd, tc } = extractFromStat(detailData.data)
        if (wr != null || mdd != null || tc != null) {
          futuresEnrichMap.set(uid, { wr, mdd, tc })
          if (i < 5) console.log(`  [${i+1}] UID ${uid}: WR=${wr} MDD=${mdd} via ${detailData.url?.split('/').pop()}`)
        }
      }

      if (!detailData || !futuresEnrichMap.has(uid)) {
        // Navigate to trader detail page and intercept
        const detailPage = await ctx.newPage()
        let intercepted = null

        detailPage.on('response', async resp => {
          if (intercepted) return
          const url = resp.url()
          if (!url.includes('trader') && !url.includes('copy')) return
          try {
            const json = await resp.json().catch(() => null)
            if (!json?.data) return
            const d = json.data
            const stat = d.rankStat || d
            const { wr, mdd } = extractFromStat(stat)
            if (wr != null || mdd != null) {
              intercepted = { wr, mdd, tc: stat.totalTransactions ? parseInt(stat.totalTransactions) : null }
            }
          } catch {}
        })

        try {
          await detailPage.goto(`https://bingx.com/en/copytrading/tradeDetail/${uid}`, {
            waitUntil: 'networkidle', timeout: 30000
          }).catch(() => {})
          await sleep(4000)
        } catch {}

        if (intercepted) {
          futuresEnrichMap.set(uid, intercepted)
          console.log(`  [${i+1}] UID ${uid}: WR=${intercepted.wr} MDD=${intercepted.mdd} (intercepted)`)
        } else if (i < 5 || i === missingAfterRecommend.length - 1) {
          console.log(`  [${i+1}] UID ${uid}: not found`)
        }

        await detailPage.close().catch(() => {})
      }

      await sleep(500)
    }
  }

  const stillMissingBingx = bingxUIDs.filter(uid => {
    const d = futuresEnrichMap.get(uid)
    return !d || d.mdd == null
  })
  console.log(`\n  Final bingx futures: ${futuresEnrichMap.size} with data, ${stillMissingBingx.length} still missing MDD`)

  // ── 6. Load BingX Spot Copy Trading ────────────────────────────────
  const spotEnrichMap = new Map()
  
  console.log('\n🌐 Loading BingX spot copy trading...')
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => console.log('  ⚠ Spot load timeout'))
  await sleep(8000)
  
  if (!capturedSpotHeaders) {
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(2000)
    }
  }

  // ── 7. Paginate Spot API ────────────────────────────────────────────
  if (capturedSpotHeaders || capturedFuturesHeaders) {
    const spotHeaders = capturedSpotHeaders || capturedFuturesHeaders
    console.log('\n📡 Paginating spot trader search API...')
    
    const spotApiUrls = [
      'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search',
      'https://api-app.qq-os.com/api/copy-trade-facade/v1/spot/trader/search',
      'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/recommend',
    ]
    
    for (const baseUrl of spotApiUrls) {
      for (const sortType of [0, 1, 2, 3, 4, 5]) {
        for (let pageId = 0; pageId < 30; pageId++) {
          try {
            const result = await page.evaluate(async ({ url, headers, pageId, sortType }) => {
              const body = { pageId, pageSize: 20, sortType }
              const r = await fetch(`${url}?pageId=${pageId}&pageSize=20`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              })
              if (!r.ok) return null
              return await r.json()
            }, { url: baseUrl, headers: spotHeaders, pageId, sortType })

            if (!result || result.code !== 0) {
              if (pageId === 0 && sortType === 0) console.log(`  ${baseUrl.split('/').pop()}: code=${result?.code}`)
              break
            }
            const items = result?.data?.result || result?.data?.list || []
            if (!items.length) break

            for (const item of items) {
              const traderInfo = item.trader || item
              const nickName = traderInfo.nickName || traderInfo.nickname || traderInfo.traderName || ''
              const uid = String(traderInfo.uid || traderInfo.uniqueId || traderInfo.traderId || '')
              const stat = item.rankStat || item.stat || item
              const { wr, mdd, tc } = extractFromStat(stat)
              
              // Store by nickname slug and uid
              if (nickName) {
                const slug = nickName.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
                if (wr != null || mdd != null) spotEnrichMap.set(slug, { wr, mdd, tc, nickName, uid })
              }
              if (uid && uid !== '0') spotEnrichMap.set(uid, { wr, mdd, tc, nickName, uid })
            }

            if (items.length < 20) break
            await sleep(400)
          } catch { break }
        }
      }
      console.log(`  ${baseUrl.split('/').pop()}: collected ${spotEnrichMap.size / 2 | 0} spot traders`)
      if (spotEnrichMap.size > 0) break
    }
  }

  // Search for missing spot traders by handle
  const spotEnrichedIds = new Set()
  for (const traderId of spotTraderIds) {
    if (spotEnrichMap.has(traderId)) spotEnrichedIds.add(traderId)
    // Also check by handle
    const row = spotRows.find(r => r.source_trader_id === traderId)
    if (row?.handle) {
      const handleSlug = row.handle.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
      if (spotEnrichMap.has(handleSlug)) spotEnrichedIds.add(traderId)
    }
  }
  const missingSpotIds = spotTraderIds.filter(id => !spotEnrichedIds.has(id))
  console.log(`  Missing spot traders after bulk fetch: ${missingSpotIds.length}/${spotTraderIds.length}`)

  // Try individual spot trader page navigation
  if (missingSpotIds.length > 0) {
    const spotHeaders = capturedSpotHeaders || capturedFuturesHeaders
    console.log(`\n🔍 Searching for ${missingSpotIds.length} missing spot traders...`)
    
    for (const traderId of missingSpotIds) {
      const row = spotRows.find(r => r.source_trader_id === traderId)
      const handle = row?.handle || ''
      
      if (!spotHeaders) continue

      // Try keyword search
      const searchResult = await page.evaluate(async ({ handle, headers }) => {
        const searchEndpoints = [
          'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search',
          'https://api-app.qq-os.com/api/copy-trade-facade/v1/spot/trader/search',
        ]
        for (const url of searchEndpoints) {
          try {
            const r = await fetch(`${url}?pageId=0&pageSize=10&keyword=${encodeURIComponent(handle)}`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ keyword: handle, pageId: 0, pageSize: 10 })
            })
            if (!r.ok) continue
            const json = await r.json()
            if (json?.code === 0) {
              const items = json?.data?.result || json?.data?.list || []
              return { items, url }
            }
          } catch {}
        }
        return null
      }, { handle, headers: spotHeaders }).catch(() => null)

      if (searchResult?.items?.length > 0) {
        for (const item of searchResult.items) {
          const traderInfo = item.trader || item
          const nickName = traderInfo.nickName || traderInfo.nickname || ''
          const stat = item.rankStat || item
          const { wr, mdd, tc } = extractFromStat(stat)
          if (nickName && (wr != null || mdd != null)) {
            const slug = nickName.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
            spotEnrichMap.set(slug, { wr, mdd, tc, nickName })
            spotEnrichMap.set(traderId, { wr, mdd, tc, nickName })
            console.log(`  ✓ ${handle}: WR=${wr} MDD=${mdd} via search`)
          }
        }
      } else {
        // Navigate to spot trader detail page
        const detailPage = await ctx.newPage()
        let intercepted = null
        
        detailPage.on('response', async resp => {
          if (intercepted) return
          const url = resp.url()
          if (!url.includes('spot') && !url.includes('trader')) return
          try {
            const json = await resp.json().catch(() => null)
            if (!json?.data) return
            const d = json.data
            const { wr, mdd, tc } = extractFromStat(d.rankStat || d)
            if (wr != null || mdd != null) intercepted = { wr, mdd, tc }
          } catch {}
        })

        try {
          const slug = traderId
          await detailPage.goto(`https://bingx.com/en/CopyTrading/spot/${slug}/`, {
            waitUntil: 'networkidle', timeout: 25000
          }).catch(() => {})
          await sleep(4000)
        } catch {}

        if (intercepted) {
          spotEnrichMap.set(traderId, intercepted)
          console.log(`  ✓ ${handle}: WR=${intercepted.wr} MDD=${intercepted.mdd} (page intercept)`)
        } else {
          console.log(`  ✗ ${handle}: not found`)
        }

        await detailPage.close().catch(() => {})
        await sleep(500)
      }
    }
  }

  await browser.close()
  console.log('\n✅ Browser closed')

  // ── 8. Update DB ────────────────────────────────────────────────────
  console.log('\n📝 Updating database...')

  // Update bingx futures
  let bingxUpdated = 0, bingxErrors = 0
  for (const row of (bingxRows || [])) {
    const d = futuresEnrichMap.get(row.source_trader_id)
    if (!d) continue

    const updates = {}
    if (row.max_drawdown == null && d.mdd != null && !isNaN(d.mdd)) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null && !isNaN(d.wr)) updates.win_rate = d.wr
    
    if (!Object.keys(updates).length) continue

    if (DRY_RUN) {
      console.log(`  [DRY] bingx row ${row.id} (${row.handle}): ${JSON.stringify(updates)}`)
      bingxUpdated++
      continue
    }

    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) bingxUpdated++
    else { bingxErrors++; if (bingxErrors <= 3) console.error(`  Update error ${row.id}: ${error.message}`) }
  }
  console.log(`  bingx: ${bingxUpdated}/${bingxRows.length} rows updated (errors: ${bingxErrors})`)

  // Also sync to trader_snapshots for bingx
  const { data: snapBingx } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, win_rate, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)
  let snapBingxUpdated = 0
  for (const row of (snapBingx || [])) {
    const d = futuresEnrichMap.get(row.source_trader_id)
    if (!d?.mdd) continue
    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots').update({ max_drawdown: d.mdd }).eq('id', row.id)
      if (!error) snapBingxUpdated++
    }
  }
  console.log(`  trader_snapshots bingx: ${snapBingxUpdated} rows updated`)

  // Update bingx_spot
  let spotUpdated = 0, spotErrors = 0
  for (const row of (spotRows || [])) {
    const traderId = row.source_trader_id
    const handleSlug = (row.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    
    let d = spotEnrichMap.get(traderId) || spotEnrichMap.get(handleSlug)
    if (!d) continue

    const updates = {}
    if (row.max_drawdown == null && d.mdd != null && !isNaN(d.mdd)) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null && !isNaN(d.wr)) updates.win_rate = d.wr
    
    if (!Object.keys(updates).length) continue

    if (DRY_RUN) {
      console.log(`  [DRY] bingx_spot row ${row.id} (${row.handle}): ${JSON.stringify(updates)}`)
      spotUpdated++
      continue
    }

    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) spotUpdated++
    else { spotErrors++; if (spotErrors <= 3) console.error(`  Update error ${row.id}: ${error.message}`) }
  }
  console.log(`  bingx_spot: ${spotUpdated}/${spotRows.length} rows updated (errors: ${spotErrors})`)

  // Also sync spot to trader_snapshots
  const { data: snapSpot } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')
  let snapSpotUpdated = 0
  for (const row of (snapSpot || [])) {
    const traderId = row.source_trader_id
    const handleSlug = (row.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotEnrichMap.get(traderId) || spotEnrichMap.get(handleSlug)
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) snapSpotUpdated++
    }
  }
  console.log(`  trader_snapshots bingx_spot: ${snapSpotUpdated} rows updated`)

  // ── 9. Final Counts ─────────────────────────────────────────────────
  console.log('\n📊 Final null counts:')
  for (const [source, tbl] of [['bingx', 'leaderboard_ranks'], ['bingx_spot', 'leaderboard_ranks'], ['bingx', 'trader_snapshots'], ['bingx_spot', 'trader_snapshots']]) {
    const { count: mddNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('max_drawdown', null)
    const { count: wrNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('win_rate', null)
    const { count: total } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source)
    console.log(`  ${tbl} source='${source}': total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)
  }

  console.log('\n✅ Done!')
}

main().catch(e => { console.error(e); process.exit(1) })

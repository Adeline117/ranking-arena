/**
 * WEEX scraper - route.fetch() pagination approach
 * Intercepts the browser's own API requests and replays them for all pages
 * Uses Playwright route.fetch() which is the same as the browser making the request
 */
import { chromium } from 'playwright'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'weex'
const PROXY = 'http://127.0.0.1:7890'

function parseTrader(item) {
  const id = String(item.traderUserId || '')
  if (!id) return null

  let roi = 0
  if (item.totalReturnRate != null) {
    roi = parseFloat(String(item.totalReturnRate))
    if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100
  }

  const ratesByDays = {}
  if (Array.isArray(item.ndaysReturnRates)) {
    for (const r of item.ndaysReturnRates) {
      let rate = parseFloat(String(r.rate || 0))
      if (Math.abs(rate) > 0 && Math.abs(rate) < 1) rate *= 100
      ratesByDays[r.ndays] = rate
    }
  }

  let wr = item.winRate != null ? parseFloat(String(item.winRate)) : null
  if (wr != null && wr > 0 && wr <= 1) wr *= 100
  let dd = item.maxDrawdown != null ? Math.abs(parseFloat(String(item.maxDrawdown))) : null
  if (dd != null && dd > 0 && dd <= 1) dd *= 100

  return {
    id,
    name: item.traderNickName || item.nickName || `Trader_${id.slice(0, 8)}`,
    avatar: item.headPic || null,
    roi, roi7d: ratesByDays[7] || null, roi21d: ratesByDays[21] || roi, roi90d: ratesByDays[90] || null,
    pnl: parseFloat(String(item.threeWeeksPNL || item.profit || 0)),
    followers: parseInt(String(item.followCount || 0)),
    winRate: wr, maxDrawdown: dd,
  }
}

async function scrapeAllTraders() {
  console.log('WEEX paginator: launching browser...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  const traders = new Map()
  let gatewayUrl = null
  let firstRequestHeaders = null
  const paginationDone = new Set() // track which (sortRule, pageNo) combos we've done

  // When the page makes its first request, we capture the URL and headers
  // then trigger ALL pages via route.fetch()
  await ctx.route('**/*traderListView*', async (route) => {
    const req = route.request()
    const url = req.url()
    const bodyStr = req.postData() || '{}'
    const headers = req.headers()
    
    // Store gateway URL and headers from first request
    if (!gatewayUrl) {
      gatewayUrl = url
      firstRequestHeaders = headers
      console.log('  Gateway:', gatewayUrl)
    }

    // Parse the original body
    let body
    try { body = JSON.parse(bodyStr) } catch { body = {} }
    
    const cacheKey = `${body.sortRule}:${body.pageNo}`
    if (!paginationDone.has(cacheKey)) {
      paginationDone.add(cacheKey)
    }

    // Continue the original request
    const response = await route.fetch()
    const respBody = await response.text()
    
    // Parse and store traders from this response
    try {
      const json = JSON.parse(respBody)
      if (json.code === 'SUCCESS') {
        let added = 0
        for (const item of (json.data?.rows || [])) {
          const t = parseTrader(item)
          if (t && !traders.has(t.id)) { traders.set(t.id, t); added++ }
        }
        if (added > 0) console.log(`  sort=${body.sortRule} p${body.pageNo}: +${added} → ${traders.size} (total: ${json.data?.totals || '?'})`)
      }
    } catch {}

    // Fulfill the request with the original response
    await route.fulfill({ response })
  })

  const page = await ctx.newPage()
  await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(8000)
  console.log(`  After initial load: ${traders.size}`)

  // Now we have the gateway URL and headers, fetch all pages
  if (gatewayUrl && firstRequestHeaders) {
    console.log('  Starting pagination via route.fetch()...')
    
    // Sort rules to try
    for (const sortRule of [0, 9, 5, 2, 6, 7, 8, 1]) {
      let pageNo = 1
      let consecutiveEmpty = 0
      
      while (pageNo <= 50 && consecutiveEmpty < 2) {
        const cacheKey = `${sortRule}:${pageNo}`
        if (paginationDone.has(cacheKey)) { pageNo++; continue }
        
        const body = JSON.stringify({ languageType: 0, sortRule, simulation: 0, pageNo, pageSize: 9, nickName: '' })
        
        try {
          const resp = await page.evaluate(async ({ url, headers, body }) => {
            try {
              const r = await fetch(url, {
                method: 'POST',
                headers: { ...headers, 'content-length': String(body.length) },
                body,
              })
              const text = await r.text()
              return { status: r.status, text }
            } catch(e) {
              return { error: e.message }
            }
          }, { url: gatewayUrl, headers: firstRequestHeaders, body })

          if (resp.error) {
            if (pageNo === 1) console.log(`  sort=${sortRule}: ${resp.error}`)
            consecutiveEmpty++
            pageNo++
            continue
          }

          try {
            const json = JSON.parse(resp.text)
            if (json.code !== 'SUCCESS' || !json.data?.rows?.length) {
              consecutiveEmpty++
              pageNo++
              continue
            }
            
            let added = 0
            for (const item of json.data.rows) {
              const t = parseTrader(item)
              if (t && !traders.has(t.id)) { traders.set(t.id, t); added++ }
            }
            if (added > 0) {
              consecutiveEmpty = 0
              console.log(`  sort=${sortRule} p${pageNo}: +${added} → ${traders.size}`)
            } else {
              consecutiveEmpty++
            }
            if (!json.data.nextFlag) break
          } catch {
            consecutiveEmpty++
          }
        } catch(e) {
          consecutiveEmpty++
        }
        
        paginationDone.add(cacheKey)
        pageNo++
        await sleep(300)
      }
    }
  }

  await browser.close()
  console.log(`\n  Total unique traders: ${traders.size}`)
  return [...traders.values()]
}

async function saveToDb(traders) {
  if (!traders.length) { console.log('❌ No data'); return false }

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const periods = ['7D', '30D', '90D']
  const now = new Date().toISOString()

  // Save trader_sources
  for (let i = 0; i < traders.length; i += 50) {
    const { error } = await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 50).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
      })),
      { onConflict: 'source,source_trader_id' }
    )
    if (error) console.log(`  source err: ${error.message}`)
  }
  console.log(`✅ trader_sources: ${traders.length} upserted`)

  let totalLR = 0

  for (const period of periods) {
    console.log(`\n💾 Period ${period}: ${traders.length} traders...`)
    let savedSnap = 0, savedLR = 0

    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30)

      // trader_snapshots
      const snapBatch = batch.map((t, j) => {
        let roi = t.roi || 0
        if (period === '7D' && t.roi7d != null) roi = t.roi7d
        if (period === '90D' && t.roi90d != null) roi = t.roi90d
        const scores = calculateArenaScore(roi, t.pnl, t.maxDrawdown, t.winRate, period)
        return {
          source: SOURCE, source_trader_id: t.id, season_id: period,
          rank: i + j + 1, roi, pnl: t.pnl || null,
          win_rate: t.winRate, max_drawdown: t.maxDrawdown,
          followers: t.followers, arena_score: scores.totalScore,
          captured_at: now,
        }
      })
      const { error: snapErr } = await supabase.from('trader_snapshots')
        .upsert(snapBatch, { onConflict: 'source,source_trader_id,season_id' })
      if (!snapErr) savedSnap += snapBatch.length

      // leaderboard_ranks
      const lrBatch = batch.map((t, j) => {
        let roi = t.roi || 0
        if (period === '7D' && t.roi7d != null) roi = t.roi7d
        if (period === '90D' && t.roi90d != null) roi = t.roi90d
        const scores = calculateArenaScore(roi, t.pnl, t.maxDrawdown, t.winRate, period)
        return {
          source: SOURCE,
          source_type: 'futures',
          source_trader_id: t.id,
          season_id: period,
          rank: i + j + 1,
          handle: t.name,
          avatar_url: t.avatar || null,
          roi,
          pnl: t.pnl || null,
          win_rate: t.winRate,
          max_drawdown: t.maxDrawdown,
          followers: t.followers || null,
          arena_score: scores.totalScore,
          computed_at: now,
        }
      })
      const { error: lrErr } = await supabase.from('leaderboard_ranks')
        .upsert(lrBatch, { onConflict: 'season_id,source,source_trader_id' })
      if (!lrErr) savedLR += lrBatch.length
      else console.log(`  leaderboard err ${period}: ${lrErr.message}`)
    }

    console.log(`  snapshots: ${savedSnap} | leaderboard_ranks: ${savedLR}`)
    totalLR += savedLR
  }

  return true
}

async function main() {
  console.log('WEEX paginate import')
  const traders = await scrapeAllTraders()
  
  if (traders.length < 10) {
    console.log('⚠️  Too few traders:', traders.length, '— aborting save to avoid data loss')
    process.exit(1)
  }

  await saveToDb(traders)

  // Final verification
  const { count: lrCount } = await supabase
    .from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: snapCount } = await supabase
    .from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE)

  console.log('\n📊 Verification:')
  console.log(`  leaderboard_ranks (weex): ${lrCount}`)
  console.log(`  trader_snapshots (weex): ${snapCount}`)
}

main().catch(e => { console.error(e); process.exit(1) })

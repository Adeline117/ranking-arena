/**
 * WEEX scraper - route.fetch() piggybacking
 * When the browser makes its first legit request, we intercept it and
 * use route.fetch() to make ALL pages before continuing.
 * route.fetch() uses the browser's network stack so Cloudflare allows it.
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
  console.log('WEEX route.fetch scraper: launching...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  const traders = new Map()
  let totalKnown = null
  let paginationTriggered = false

  // Intercept ALL traderListView requests (not topTraderListView)
  await ctx.route('**/trace/traderListView*', async (route) => {
    const req = route.request()
    const originalBody = JSON.parse(req.postData() || '{}')
    
    // First time we see a legit request: fetch all pages
    if (!paginationTriggered) {
      paginationTriggered = true
      const baseUrl = req.url()
      console.log(`  Intercepted first request → ${baseUrl.slice(0, 80)}`)
      console.log(`  Original body: sortRule=${originalBody.sortRule} pageNo=${originalBody.pageNo}`)
      
      // Fetch all pages for all sort rules while we have this legit connection
      const sortRules = [0, 9, 5, 2, 6, 7, 8, 1]
      let processed = new Set()
      
      for (const sortRule of sortRules) {
        for (let pageNo = 1; pageNo <= 50; pageNo++) {
          const key = `${sortRule}:${pageNo}`
          if (processed.has(key)) continue
          processed.add(key)
          
          const body = JSON.stringify({
            languageType: 0, sortRule, simulation: 0,
            pageNo, pageSize: 20, nickName: ''
          })
          
          try {
            const resp = await route.fetch({ postData: body })
            const text = await resp.text()
            const json = JSON.parse(text)
            
            if (json.code !== 'SUCCESS') {
              if (pageNo === 1) console.log(`  sort=${sortRule}: code=${json.code}`)
              break
            }
            if (!totalKnown && json.data?.totals) totalKnown = json.data.totals
            
            const rows = json.data?.rows || []
            if (!rows.length) break
            
            let added = 0
            for (const item of rows) {
              const t = parseTrader(item)
              if (t && !traders.has(t.id)) { traders.set(t.id, t); added++ }
            }
            
            if (added > 0 || pageNo === 1) {
              console.log(`  sort=${sortRule} p${pageNo}: +${added} → ${traders.size}/${totalKnown || '?'}`)
            }
            
            if (!json.data.nextFlag || added === 0) break
          } catch (e) {
            console.log(`  sort=${sortRule} p${pageNo} err: ${e.message}`)
            if (pageNo === 1) break
            break
          }
          
          await sleep(150)
        }
      }
      
      console.log(`  Pagination complete: ${traders.size} traders collected`)
    }
    
    // Continue original request to not break the page
    await route.continue()
  })

  const page = await ctx.newPage()
  await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'domcontentloaded' })
  // Wait for pagination to complete (it runs in the route handler)
  await sleep(3000)
  
  await browser.close()
  return [...traders.values()]
}

async function saveToDb(traders) {
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const periods = ['7D', '30D', '90D']
  const now = new Date().toISOString()

  // trader_sources
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
  console.log(`✅ trader_sources: ${traders.length}`)

  let totalLR = 0
  for (const period of periods) {
    console.log(`\n💾 ${period}: ${traders.length} traders...`)
    let savedLR = 0, savedSnap = 0

    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30)

      const snapBatch = batch.map((t, j) => {
        let roi = t.roi || 0
        if (period === '7D' && t.roi7d != null) roi = t.roi7d
        if (period === '90D' && t.roi90d != null) roi = t.roi90d
        const scores = calculateArenaScore(roi, t.pnl, t.maxDrawdown, t.winRate, period)
        return {
          source: SOURCE, source_trader_id: t.id, season_id: period,
          rank: i + j + 1, roi, pnl: t.pnl || null,
          win_rate: t.winRate, max_drawdown: t.maxDrawdown,
          followers: t.followers, arena_score: scores.totalScore, captured_at: now,
        }
      })
      const { error: se } = await supabase.from('trader_snapshots')
        .upsert(snapBatch, { onConflict: 'source,source_trader_id,season_id' })
      if (!se) savedSnap += snapBatch.length

      const lrBatch = batch.map((t, j) => {
        let roi = t.roi || 0
        if (period === '7D' && t.roi7d != null) roi = t.roi7d
        if (period === '90D' && t.roi90d != null) roi = t.roi90d
        const scores = calculateArenaScore(roi, t.pnl, t.maxDrawdown, t.winRate, period)
        return {
          source: SOURCE, source_type: 'futures',
          source_trader_id: t.id, season_id: period,
          rank: i + j + 1, handle: t.name, avatar_url: t.avatar || null,
          roi, pnl: t.pnl || null, win_rate: t.winRate, max_drawdown: t.maxDrawdown,
          followers: t.followers || null, arena_score: scores.totalScore, computed_at: now,
        }
      })
      const { error: le } = await supabase.from('leaderboard_ranks')
        .upsert(lrBatch, { onConflict: 'season_id,source,source_trader_id' })
      if (!le) savedLR += lrBatch.length
      else console.log(`  LR err: ${le.message}`)
    }
    console.log(`  snapshots: ${savedSnap} | leaderboard_ranks: ${savedLR}`)
    totalLR += savedLR
  }

  return totalLR
}

async function main() {
  console.log('WEEX route.fetch import')
  const traders = await scrapeAllTraders()
  console.log(`\n📊 Scraped: ${traders.length} traders`)

  if (traders.length < 15) {
    console.log('⚠️  Too few traders, aborting')
    process.exit(1)
  }

  await saveToDb(traders)

  // Verify
  const { count: lr } = await supabase.from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: snap } = await supabase.from('trader_snapshots')
    .select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  console.log(`\n✅ Final: leaderboard_ranks(weex)=${lr}, trader_snapshots(weex)=${snap}`)
}

main().catch(e => { console.error(e); process.exit(1) })

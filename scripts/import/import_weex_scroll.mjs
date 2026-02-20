/**
 * WEEX scraper - scroll-based approach
 * Uses Playwright UI scrolling + tab switching to collect all 360 traders via API interception
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
    roi,
    roi7d: ratesByDays[7] || null,
    roi21d: ratesByDays[21] || roi,
    roi90d: ratesByDays[90] || null,
    pnl: parseFloat(String(item.threeWeeksPNL || item.profit || 0)),
    followers: parseInt(String(item.followCount || 0)),
    winRate: wr,
    maxDrawdown: dd,
  }
}

async function scrapeAllTraders() {
  console.log('WEEX scroll scraper: launching browser...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await ctx.newPage()
  const traders = new Map()
  let totalKnown = null

  page.on('response', async (r) => {
    const url = r.url()
    if (!url.includes('traderListView')) return
    try {
      const json = await r.json()
      if (json.code !== 'SUCCESS') return
      if (totalKnown === null && json.data?.totals) totalKnown = json.data.totals
      const rows = json.data?.rows || []
      let added = 0
      for (const item of rows) {
        const t = parseTrader(item)
        if (t && !traders.has(t.id)) { traders.set(t.id, t); added++ }
      }
      if (added > 0) console.log(`  API: +${added} → ${traders.size}/${totalKnown || '?'}`)
    } catch {}
  })

  // Load main page
  await page.goto('https://www.weex.com/copy-trading', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(8000)
  console.log(`After initial load: ${traders.size}`)

  // Scroll loop for current view
  async function scrollAll() {
    let prevCount = 0
    let stableRounds = 0
    for (let i = 0; i < 60 && stableRounds < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      
      // Also try clicking "Load More" type buttons
      try {
        const loadMore = await page.$('[class*="load-more"], [class*="loadMore"], button:has-text("更多"), button:has-text("Load More")')
        if (loadMore) { await loadMore.click(); await sleep(2000) }
      } catch {}

      if (traders.size === prevCount) stableRounds++
      else { stableRounds = 0; prevCount = traders.size }
    }
  }

  await scrollAll()
  console.log(`After first scroll pass: ${traders.size}`)

  // Try clicking time period tabs (7D, 30D, 90D, etc.)
  const timeLabels = ['7D', '30D', '90D', '7天', '30天', '90天', '7 Days', '30 Days', '90 Days']
  for (const label of timeLabels) {
    try {
      const tab = await page.$(`button:has-text("${label}"), [role="tab"]:has-text("${label}"), [class*="tab"]:has-text("${label}")`)
      if (tab) {
        await tab.click()
        await sleep(4000)
        await scrollAll()
        console.log(`After ${label} tab: ${traders.size}`)
      }
    } catch {}
  }

  // Try sort option buttons (Trending, New etc.)
  const sortLabels = ['Trending', 'New', 'ROI', '收益', '新', '精选']
  for (const label of sortLabels) {
    try {
      const btn = await page.$(`button:has-text("${label}")`)
      if (btn) {
        await btn.click()
        await sleep(4000)
        await scrollAll()
        console.log(`After sort "${label}": ${traders.size}`)
      }
    } catch {}
  }

  // Navigate to the "all traders" or leaderboard full list URL variant
  const altUrls = [
    'https://www.weex.com/copy-trading?tab=all',
    'https://www.weex.com/copy-trading?sort=roi',
    'https://www.weex.com/copy-trading?dataRange=7',
    'https://www.weex.com/copy-trading?dataRange=30',
    'https://www.weex.com/copy-trading?dataRange=90',
  ]
  for (const url of altUrls) {
    try {
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
      await sleep(6000)
      await scrollAll()
    } catch {}
    console.log(`After ${url}: ${traders.size}`)
  }

  console.log(`\nTotal unique traders: ${traders.size}`)
  await browser.close()
  return [...traders.values()]
}

async function main() {
  console.log('WEEX scroll import | Periods: 7D, 30D, 90D')
  const periods = ['7D', '30D', '90D']

  const traders = await scrapeAllTraders()
  if (!traders.length) { console.log('❌ No data'); process.exit(1) }

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  console.log(`\n📊 ${traders.length} traders scraped`)

  // Save to trader_sources
  for (let i = 0; i < traders.length; i += 50) {
    const { error } = await supabase.from('trader_sources').upsert(
      traders.slice(i, i + 50).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
      })),
      { onConflict: 'source,source_trader_id' }
    )
    if (error) console.log(`  sources err: ${error.message}`)
  }
  console.log(`✅ trader_sources upserted`)

  // Save to trader_snapshots + leaderboard_ranks for each period
  const now = new Date().toISOString()
  let totalSnaps = 0
  let totalLR = 0

  for (const period of periods) {
    console.log(`\n💾 Saving ${traders.length} records for ${period}...`)
    let savedSnap = 0
    let savedLR = 0

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
      else console.log(`  snapshot err: ${snapErr.message}`)

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
      else console.log(`  leaderboard err: ${lrErr.message}`)
    }

    console.log(`  trader_snapshots: ${savedSnap}/${traders.length}`)
    console.log(`  leaderboard_ranks: ${savedLR}/${traders.length}`)
    totalSnaps += savedSnap
    totalLR += savedLR
  }

  // Verify
  const { count: lrCount } = await supabase
    .from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: snapCount } = await supabase
    .from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE)

  console.log('\n✅ Done!')
  console.log(`  trader_snapshots (weex): ${snapCount}`)
  console.log(`  leaderboard_ranks (weex): ${lrCount}`)
}

main().catch(e => { console.error(e); process.exit(1) })

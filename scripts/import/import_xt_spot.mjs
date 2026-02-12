/**
 * XT Spot Copy Trading scraper (Direct API)
 *
 * APIs discovered via Playwright:
 *   - elite-leader-list-v3 (sapi): top spot traders by category (INCOME_RATE, STEADY, CURRENT_FOLLOWER_NUMBER)
 *   - leader-list-v2 (sapi): all spot traders with cursor-based pagination (direction=NEXT&id=<lastAccountId>)
 *
 * Pagination: cursor-based using `direction=NEXT&id=<lastAccountId>` and `limit=50`
 *
 * Usage: node scripts/import/import_xt_spot.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'xt'
const MARKET_TYPE = 'spot'
const BASE = 'https://www.xt.com'
const DAYS_MAP = { '7D': 7, '30D': 30, '90D': 90 }

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })
  const text = await r.text()
  try { return JSON.parse(text) } catch { return null }
}

function parseTrader(it) {
  const id = String(it.accountId || '')
  if (!id) return null
  let roi = it.incomeRate != null ? parseFloat(it.incomeRate) * 100 : null
  let pnl = it.income != null ? parseFloat(it.income) : null
  let wr = it.winRate != null ? parseFloat(it.winRate) : null
  if (wr != null && wr <= 1) wr *= 100
  let dd = it.maxRetraction != null ? Math.abs(parseFloat(it.maxRetraction)) : null
  if (dd != null && dd <= 1 && dd > 0) dd *= 100
  return {
    id,
    name: it.nickName || '',
    avatar: it.avatar || null,
    roi, pnl, wr, dd,
    followers: parseInt(it.followerCount || it.followNumber || 0) || null,
    tradeDays: it.tradeDays || null,
  }
}

/**
 * Fetch all spot traders using cursor-based pagination
 */
async function fetchAllTraders(days, sortType = 'INCOME_RATE') {
  const map = new Map()
  let cursor = null
  const limit = 50
  const maxPages = 10 // safety limit (~500 traders max)

  for (let page = 0; page < maxPages; page++) {
    let url = `${BASE}/sapi/v4/account/public/copy-trade/leader-list-v2?sortType=${sortType}&days=${days}&sortDirection=DESC&limit=${limit}&canFollow=false&elite=false`
    if (cursor) url += `&direction=NEXT&id=${cursor}`

    const data = await fetchJSON(url)
    if (!data || data.rc !== 0 || !data.result?.items) break

    const items = data.result.items
    if (items.length === 0) break

    for (const it of items) {
      const t = parseTrader(it)
      if (t) map.set(t.id, t)
    }

    // Set cursor to last item's accountId
    cursor = items[items.length - 1].accountId
    if (!data.result.hasNext) break
    await sleep(300)
  }

  return map
}

/**
 * Fetch elite spot traders
 */
async function fetchEliteTraders(days) {
  const map = new Map()
  try {
    const data = await fetchJSON(`${BASE}/sapi/v4/account/public/copy-trade/elite-leader-list-v3?size=5&days=${days}`)
    if (data?.rc === 0 && data.result) {
      for (const cat of data.result) {
        for (const it of (cat.items || [])) {
          const t = parseTrader(it)
          if (t) map.set(t.id, t)
        }
      }
    }
  } catch (e) {
    console.log(`  elite error: ${e.message}`)
  }
  return map
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log(`XT Spot scraper | Periods: ${periods.join(', ')}`)

  const tradersByPeriod = {}
  const allTraders = new Map()

  for (const period of ['7D', '30D', '90D']) {
    const days = DAYS_MAP[period]
    const map = new Map()

    // 1. Elite traders
    const elite = await fetchEliteTraders(days)
    for (const [id, t] of elite) map.set(id, t)
    console.log(`  ${period} elite: ${elite.size}`)

    // 2. All traders (paginated)
    const all = await fetchAllTraders(days)
    for (const [id, t] of all) {
      if (!map.has(id)) map.set(id, t)
    }
    console.log(`  ${period} all: ${all.size}`)

    tradersByPeriod[period] = map
    for (const [id, t] of map) allTraders.set(id, t)
    console.log(`  ${period}: ${map.size} unique traders`)
    await sleep(1000)
  }

  console.log(`\nTotal unique: ${allTraders.size}`)

  // Save sources
  const all = [...allTraders.values()]
  for (let i = 0; i < all.length; i += 50) {
    const { error } = await supabase.from('trader_sources').upsert(
      all.slice(i, i + 50).map(t => ({
        source: SOURCE,
        source_trader_id: t.id,
        handle: t.name || t.id,
        avatar_url: t.avatar,
        market_type: MARKET_TYPE,
        is_active: true,
        profile_url: `https://www.xt.com/en/copy-trading/spot/detail/${t.id}`,
      })),
      { onConflict: 'source,source_trader_id' }
    )
    if (error) console.log(`  source err: ${error.message}`)
  }

  let totalSaved = 0

  for (const p of periods) {
    const now = new Date().toISOString()
    const traders = [...(tradersByPeriod[p]?.values() || [])]
    if (!traders.length) { console.log(`  ${p}: no data`); continue }
    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    let saved = 0
    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30).map((t, j) => ({
        source: SOURCE,
        source_trader_id: t.id,
        season_id: p,
        rank: i + j + 1,
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.wr,
        max_drawdown: t.dd,
        followers: t.followers,
        arena_score: calculateArenaScore(t.roi, t.pnl, t.dd, t.wr, p).totalScore,
        captured_at: now,
      }))
      const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += batch.length
      else console.log(`  upsert err: ${error.message}`)
    }
    await sleep(100)
    console.log(`  ${p}: ${saved}/${traders.length} saved`)
    totalSaved += saved
  }

  console.log(`\n✅ XT Spot done: ${totalSaved} records`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

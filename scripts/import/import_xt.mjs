/**
 * XT Copy Trading scraper (Direct API)
 *
 * APIs:
 *   - elite-leader-list-v2: size=5 per category × 5 categories, days=7|30|90
 *   - leader-list-v2: 10 traders per call (pagination returns same data, different sorts may vary)
 *
 * Note: XT API pagination is broken (all pages return same 10 traders).
 * We maximize coverage by querying elite + leader across all 3 periods.
 * Real platform limit: ~60-70 unique traders.
 *
 * Usage: node scripts/import/import_xt.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'
import { HttpsProxyAgent } from 'https-proxy-agent'

const supabase = getSupabaseClient()
const SOURCE = 'xt'
const PROXY = 'http://127.0.0.1:7890'
const agent = new HttpsProxyAgent(PROXY)
const DAYS_MAP = { '7D': 7, '30D': 30, '90D': 90 }

async function fetchJSON(url) {
  const r = await fetch(url, {
    agent,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Accept': 'application/json' },
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
  return { id, name: it.nickName || '', avatar: it.avatar || null, roi, pnl, wr, dd, followers: parseInt(it.followerCount || 0) || null }
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log(`XT scraper | Periods: ${periods.join(', ')}`)

  const tradersByPeriod = {}
  const allTraders = new Map()

  for (const period of ['7D', '30D', '90D']) {
    const days = DAYS_MAP[period]
    const map = new Map()

    // 1. Elite list (5 per category × 5 categories = up to 25)
    try {
      const elite = await fetchJSON(`https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=5&days=${days}`)
      if (elite?.returnCode === 0 && elite.result) {
        for (const cat of elite.result) {
          for (const it of (cat.items || [])) {
            const t = parseTrader(it)
            if (t) map.set(t.id, t)
          }
        }
      }
    } catch (e) { console.log(`  elite ${period} error: ${e.message}`) }
    console.log(`  ${period} elite: ${map.size}`)

    // 2. Leader list (returns ~10 unique, pagination returns duplicates)
    try {
      const leader = await fetchJSON(`https://www.xt.com/fapi/user/v1/public/copy-trade/leader-list-v2?pageNo=1&pageSize=10&days=${days}`)
      if (leader?.returnCode === 0 && leader.result?.items) {
        for (const it of leader.result.items) {
          const t = parseTrader(it)
          if (t && !map.has(t.id)) map.set(t.id, t)
        }
      }
    } catch (e) { console.log(`  leader ${period} error: ${e.message}`) }

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
        source: SOURCE, source_trader_id: t.id, handle: t.name || t.id,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
        profile_url: `https://www.xt.com/en/copy-trading/futures/detail/${t.id}`,
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
        source: SOURCE, source_trader_id: t.id, season_id: p,
        rank: i + j + 1, roi: t.roi, pnl: t.pnl,
        win_rate: t.wr, max_drawdown: t.dd, followers: t.followers,
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

  console.log(`\n✅ XT done: ${totalSaved} records`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

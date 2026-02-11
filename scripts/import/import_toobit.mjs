/**
 * Toobit Copy Trading scraper (Direct API)
 *
 * APIs:
 *   - identity-type-leaders: ~36 unique across categories
 *   - leaders-new: pageSize=50, dataType=7|30|90 (numeric!), ~60 per period
 *
 * Combined: ~60-80 unique traders
 *
 * Usage: node scripts/import/import_toobit.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'toobit'
const HEADERS = {
  'Origin': 'https://www.toobit.com',
  'Referer': 'https://www.toobit.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
}
const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const PERIOD_MAP = { '7D': 7, '30D': 30, '90D': 90 }

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    return await res.json()
  } catch (e) {
    console.error(`  fetch failed: ${e.message}`)
    return null
  }
}

function parseTrader(t) {
  const id = String(t.leaderUserId || '')
  if (!id) return null
  
  let roi = 0
  if (t.leaderAvgProfitRatio != null) {
    roi = parseFloat(t.leaderAvgProfitRatio) * 100
  } else if (t.profitRate != null) {
    roi = parseFloat(t.profitRate)
    if (Math.abs(roi) <= 10) roi *= 100  // decimal format
  }

  let pnl = t.profit != null ? parseFloat(t.profit) : (t.followTotalProfit != null ? parseFloat(t.followTotalProfit) : null)
  let wr = t.winRate != null ? parseFloat(t.winRate) : null
  if (wr != null && wr > 0 && wr <= 1) wr *= 100
  let dd = t.maxDrawdown != null ? Math.abs(parseFloat(t.maxDrawdown)) : null
  if (dd != null && dd > 0 && dd <= 1) dd *= 100
  
  return {
    id, name: t.nickname || `Trader_${id.slice(0, 8)}`,
    avatar: t.avatar || null, roi, pnl, wr, dd,
    followers: parseInt(t.followCount || t.followerCount || 0) || null,
    dataType: t.dataType || null,
  }
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log(`Toobit scraper | Periods: ${periods.join(', ')}`)

  const allTraders = new Map()
  const tradersByPeriod = { '7D': new Map(), '30D': new Map(), '90D': new Map() }

  // Step 1: identity-type-leaders (categorized featured traders)
  const identity = await fetchJson(`${API_BASE}/identity-type-leaders`)
  if (identity?.code === 200 && identity.data) {
    for (const [cat, list] of Object.entries(identity.data)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const t = parseTrader(item)
        if (!t) continue
        allTraders.set(t.id, t)
        // Map dataType to period
        const dt = item.dataType
        const period = dt === 7 ? '7D' : dt === 90 ? '90D' : '30D'
        tradersByPeriod[period].set(t.id, t)
      }
    }
    console.log(`  identity-type: ${allTraders.size} unique`)
  }

  // Step 2: leaders-new with pagination for each period
  for (const period of ['7D', '30D', '90D']) {
    const dt = PERIOD_MAP[period]
    const map = tradersByPeriod[period]
    
    for (let page = 1; page <= 5; page++) {
      const data = await fetchJson(`${API_BASE}/leaders-new?pageNo=${page}&pageSize=50&sortBy=roi&sortType=desc&dataType=${dt}`)
      if (!data || data.code !== 200) break
      const items = data.data?.records || data.data?.list || []
      if (!items.length) break
      
      for (const item of items) {
        const t = parseTrader(item)
        if (t) {
          allTraders.set(t.id, t)
          map.set(t.id, t)
        }
      }
      await sleep(300)
    }
    console.log(`  ${period}: ${map.size} traders`)
  }

  // Step 3: Fetch detail for each trader to get per-period metrics
  console.log(`\nFetching details for ${allTraders.size} traders...`)
  const detailedTraders = new Map()
  
  for (const [id, t] of allTraders) {
    for (const period of periods) {
      const dt = PERIOD_MAP[period]
      const detail = await fetchJson(`${API_BASE}/leader-detail?leaderUserId=${id}&dataType=${dt}`)
      if (detail?.code === 200 && detail.data) {
        const d = detail.data
        let roi = d.profitRate != null ? parseFloat(d.profitRate) : (t.roi || 0)
        if (Math.abs(roi) <= 10 && Math.abs(roi) > 0) roi *= 100
        let wr = d.winRate != null ? parseFloat(d.winRate) : t.wr
        if (wr != null && wr > 0 && wr <= 1) wr *= 100
        let dd = d.maxDrawdown != null ? Math.abs(parseFloat(d.maxDrawdown)) : t.dd
        if (dd != null && dd > 0 && dd <= 1) dd *= 100
        
        const key = `${id}_${period}`
        detailedTraders.set(key, {
          ...t, roi, wr, dd,
          pnl: d.profit != null ? parseFloat(d.profit) : t.pnl,
          followers: d.followCount != null ? parseInt(d.followCount) : t.followers,
        })
      }
      await sleep(150)
    }
  }

  console.log(`\nTotal unique: ${allTraders.size}`)

  // Save sources
  const all = [...allTraders.values()]
  for (let i = 0; i < all.length; i += 50) {
    const { error } = await supabase.from('trader_sources').upsert(
      all.slice(i, i + 50).map(t => ({
        source: SOURCE, source_trader_id: t.id, handle: t.name,
        avatar_url: t.avatar, market_type: 'futures', is_active: true,
        profile_url: `https://www.toobit.com/en-US/copytrading/trader/info?leaderUserId=${t.id}`,
      })),
      { onConflict: 'source,source_trader_id' }
    )
    if (error) console.log(`  source err: ${error.message}`)
  }

  // Save snapshots
  let totalSaved = 0
  for (const period of periods) {
    const now = new Date().toISOString()
    // Use detailed data if available, otherwise fall back to list data
    const traders = [...allTraders.values()].map(t => {
      const key = `${t.id}_${period}`
      return detailedTraders.get(key) || t
    })
    
    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    let saved = 0
    for (let i = 0; i < traders.length; i += 30) {
      const batch = traders.slice(i, i + 30).map((t, j) => ({
        source: SOURCE, source_trader_id: t.id, season_id: period,
        rank: i + j + 1, roi: t.roi, pnl: t.pnl,
        win_rate: t.wr, max_drawdown: t.dd, followers: t.followers,
        arena_score: calculateArenaScore(t.roi, t.pnl, t.dd, t.wr, period).totalScore,
        captured_at: now,
      }))
      const { error } = await supabase.from('trader_snapshots').upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += batch.length
      else console.log(`  upsert err: ${error.message}`)
    }
    console.log(`  ${period}: ${saved}/${traders.length} saved`)
    totalSaved += saved
    await sleep(100)
  }

  console.log(`\n✅ Toobit done: ${totalSaved} records`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

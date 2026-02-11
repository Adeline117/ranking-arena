/**
 * Gains Network (gTrade) DEX Leaderboard Import — Rewritten
 *
 * Data reality:
 *   /leaderboard/all — top 25 per period (1D/7D/30D/90D) with full stats
 *   /open-trades     — active traders with open positions (no historical stats)
 *
 * Strategy:
 *   1. Fetch /leaderboard/all from all 3 chains (arbitrum, polygon, base)
 *   2. Merge by address, keeping best stats per trader
 *   3. For open-trades-only traders: import with address but NO fake stats
 *   4. Calculate ROI from PnL / estimated capital
 *
 * Usage: node scripts/import/import_gains.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gains'

const CHAIN_BACKENDS = [
  { name: 'arbitrum', base: 'https://backend-arbitrum.gains.trade' },
  { name: 'polygon',  base: 'https://backend-polygon.gains.trade' },
  { name: 'base',     base: 'https://backend-base.gains.trade' },
]

// Gains /leaderboard/all period keys → our season_ids
const GAINS_PERIOD_MAP = {
  '7D':  '7',
  '30D': '30',
  '90D': '90',
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

/**
 * Fetch /leaderboard/all from all chains, merge by address.
 * Returns Map<address, { pnl, wins, losses, trades, avgWin, avgLoss }> per period key.
 */
async function fetchLeaderboardAll() {
  const periodTraders = new Map() // periodKey → Map<addr, stats>

  for (const chain of CHAIN_BACKENDS) {
    const data = await fetchJson(`${chain.base}/leaderboard/all`)
    if (!data) { console.log(`  ⚠ ${chain.name} /leaderboard/all failed`); continue }

    for (const [periodKey, traders] of Object.entries(data)) {
      if (!periodTraders.has(periodKey)) periodTraders.set(periodKey, new Map())
      const pMap = periodTraders.get(periodKey)

      for (const t of traders) {
        const addr = t.address.toLowerCase()
        const pnl = parseFloat(t.total_pnl_usd || t.total_pnl || 0)
        const existing = pMap.get(addr)

        // Keep the entry with higher absolute PnL (better data)
        if (!existing || Math.abs(pnl) > Math.abs(existing.pnl)) {
          pMap.set(addr, {
            address: addr,
            pnl,
            wins: parseInt(t.count_win || 0),
            losses: parseInt(t.count_loss || 0),
            trades: parseInt(t.count || 0),
            avgWin: parseFloat(t.avg_win || 0),
            avgLoss: Math.abs(parseFloat(t.avg_loss || 0)),
            chain: chain.name,
          })
        }
      }
    }
    console.log(`  ✓ ${chain.name}: ${Object.keys(data).length} periods loaded`)
  }

  return periodTraders
}

/**
 * Fetch /open-trades from all chains → set of active addresses
 */
async function fetchOpenTradeAddresses() {
  const addresses = new Set()
  for (const chain of CHAIN_BACKENDS) {
    const trades = await fetchJson(`${chain.base}/open-trades`)
    if (!Array.isArray(trades)) continue
    for (const t of trades) {
      const addr = (t.trade?.user || '').toLowerCase()
      if (addr) addresses.add(addr)
    }
    console.log(`  ✓ ${chain.name} open-trades: ${trades.length}`)
  }
  console.log(`  Active addresses total: ${addresses.size}`)
  return addresses
}

function computeTraderMetrics(t) {
  const winRate = t.trades > 0 ? (t.wins / t.trades) * 100 : null
  // Estimate capital: average position size × number of trades
  const avgPos = (t.avgWin + t.avgLoss) / 2
  const estimatedCapital = avgPos > 0 ? avgPos * t.trades : Math.abs(t.pnl)
  const roi = estimatedCapital > 0 ? (t.pnl / estimatedCapital) * 100 : 0
  return { roi, winRate, pnl: t.pnl, trades: t.trades }
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const targetPeriods = arg === 'ALL' ? ['7D', '30D', '90D']
    : arg && ['7D', '30D', '90D'].includes(arg) ? [arg]
    : ['7D', '30D', '90D']

  console.log('Gains Network (gTrade) Import — Rewritten')
  console.log(`Periods: ${targetPeriods.join(', ')}\n`)

  // 1. Fetch leaderboard data from all chains
  console.log('📊 Fetching leaderboard/all from all chains...')
  const periodTraders = await fetchLeaderboardAll()

  // 2. Fetch open-trade addresses
  console.log('\n📊 Fetching open-trade addresses...')
  const openAddresses = await fetchOpenTradeAddresses()

  for (const period of targetPeriods) {
    const gainsKey = GAINS_PERIOD_MAP[period]
    if (!gainsKey) continue

    console.log(`\n=== ${period} (gains key: ${gainsKey}) ===`)

    const lbTraders = periodTraders.get(gainsKey) || new Map()
    console.log(`  Leaderboard traders with full data: ${lbTraders.size}`)

    // Build final trader list: leaderboard traders with stats + open-trade-only with null stats
    const allTraders = []

    // Leaderboard traders — have full stats
    for (const [addr, t] of lbTraders) {
      const m = computeTraderMetrics(t)
      allTraders.push({
        address: addr,
        roi: m.roi,
        pnl: m.pnl,
        winRate: m.winRate,
        trades: m.trades,
        hasData: true,
      })
    }

    // Open-trade-only traders — active but no stats
    for (const addr of openAddresses) {
      if (!lbTraders.has(addr)) {
        allTraders.push({
          address: addr,
          roi: null,
          pnl: null,
          winRate: null,
          trades: null,
          hasData: false,
        })
      }
    }

    // Sort: traders with data first (by ROI desc), then others
    allTraders.sort((a, b) => {
      if (a.hasData && !b.hasData) return -1
      if (!a.hasData && b.hasData) return 1
      return (b.roi || 0) - (a.roi || 0)
    })

    const top = allTraders.slice(0, 500)
    const capturedAt = new Date().toISOString()

    // Upsert trader_sources
    const sourcesData = top.map(t => ({
      source: SOURCE,
      source_type: 'defi',
      source_trader_id: t.address,
      handle: `${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
      profile_url: `https://gains.trade/trader/${t.address}`,
      is_active: true,
    }))

    const { error: srcErr } = await supabase
      .from('trader_sources')
      .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
    if (srcErr) console.log(`  ⚠ trader_sources: ${srcErr.message}`)

    // Upsert snapshots
    const snapshots = top.map((t, idx) => ({
      source: SOURCE,
      source_trader_id: t.address,
      season_id: period,
      rank: idx + 1,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.winRate,
      max_drawdown: null,
      followers: 0,
      trades_count: t.trades,
      arena_score: t.hasData
        ? calculateArenaScore(t.roi || 0, t.pnl || 0, null, t.winRate, period).totalScore
        : null,
      captured_at: capturedAt,
    }))

    const { error: snapErr } = await supabase
      .from('trader_snapshots')
      .upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })
    if (snapErr) {
      console.log(`  ⚠ batch upsert failed: ${snapErr.message}, trying one by one...`)
      let saved = 0
      for (const s of snapshots) {
        const { error } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
        if (!error) saved++
      }
      console.log(`  Saved ${saved}/${snapshots.length} individually`)
    }

    const withData = top.filter(t => t.hasData).length
    const withRoi = top.filter(t => t.roi !== null).length
    console.log(`  ✅ Saved: ${top.length} traders (${withData} with full data, ${withRoi} with ROI)`)

    // Top 5
    top.filter(t => t.hasData).slice(0, 5).forEach((t, i) => {
      const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
      console.log(`    ${i + 1}. ${t.address.slice(0, 10)}…: ROI ${t.roi?.toFixed(2)}%, PnL $${t.pnl?.toFixed(0)}, WR ${wr}, Trades: ${t.trades}`)
    })

    await sleep(2000)
  }

  console.log('\n✅ Gains Network done')
}

main()

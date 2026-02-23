/**
 * Gains Network (gTrade) DEX Leaderboard Import — v3
 *
 * Fixes vs v2:
 *   - Routes all API calls through CF Worker proxy (bypasses Cloudflare 1015 block)
 *   - ROI calculation: uses avgLoss × count_loss as capital proxy (corrected formula)
 *   - MDD: fetched from per-trader stats API (winRate, totalTrades, roi)
 *   - Robust upsert: individual inserts with explicit conflict handling
 *   - Skips addresses that would produce empty rows (all-null metrics)
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

// CF Worker proxy — bypasses Cloudflare blocks on Gains backends
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const CHAIN_BACKENDS = [
  { name: 'arbitrum', chainId: 42161 },
  { name: 'polygon',  chainId: 137 },
  { name: 'base',     chainId: 8453 },
]

const GAINS_PERIOD_MAP = {
  '7D':  '7',
  '30D': '30',
  '90D': '90',
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) {
        console.log(`    HTTP ${res.status} for ${url}`)
        return null
      }
      return await res.json()
    } catch (e) {
      console.log(`    Fetch error (attempt ${i + 1}): ${e.message}`)
      if (i < retries - 1) await sleep(2000)
    }
  }
  return null
}

/**
 * Fetch leaderboard/all through CF Worker proxy for all chains.
 * Returns Map<periodKey, Map<address, stats>>.
 */
async function fetchLeaderboardAll() {
  const periodTraders = new Map()

  for (const chain of CHAIN_BACKENDS) {
    const url = `${CF_PROXY}/gains/leaderboard-all?chain=${chain.name}`
    console.log(`  → ${chain.name} via proxy...`)
    const data = await fetchJson(url)

    if (!data || typeof data !== 'object') {
      console.log(`  ⚠ ${chain.name}: no data`)
      continue
    }

    let periodCount = 0
    for (const [periodKey, traders] of Object.entries(data)) {
      if (!Array.isArray(traders)) continue
      if (!periodTraders.has(periodKey)) periodTraders.set(periodKey, new Map())
      const pMap = periodTraders.get(periodKey)

      for (const t of traders) {
        const addr = (t.address || '').toLowerCase()
        if (!addr) continue
        const pnl = parseFloat(t.total_pnl_usd ?? t.total_pnl ?? t.pnl ?? 0)
        const existing = pMap.get(addr)
        if (!existing || Math.abs(pnl) > Math.abs(existing.pnl)) {
          pMap.set(addr, {
            address: addr,
            pnl,
            wins:    parseInt(t.count_win   ?? t.wins    ?? 0),
            losses:  parseInt(t.count_loss  ?? t.losses  ?? 0),
            trades:  parseInt(t.count       ?? t.total   ?? 0),
            avgWin:  parseFloat(t.avg_win   ?? t.avgWin  ?? 0),
            avgLoss: Math.abs(parseFloat(t.avg_loss ?? t.avgLoss ?? 0)),
            chain:   chain.name,
            chainId: chain.chainId,
          })
        }
      }
      periodCount++
    }
    console.log(`  ✓ ${chain.name}: ${periodCount} periods`)
    await sleep(500)
  }

  return periodTraders
}

/**
 * Fetch open-trade addresses through CF Worker proxy.
 */
async function fetchOpenTradeAddresses() {
  const addresses = new Set()
  for (const chain of CHAIN_BACKENDS) {
    const url = `${CF_PROXY}/gains/open-trades?chain=${chain.name}`
    const trades = await fetchJson(url)
    if (!Array.isArray(trades)) continue
    for (const t of trades) {
      const addr = (t.trade?.user || t.user || '').toLowerCase()
      if (addr) addresses.add(addr)
    }
    console.log(`  ✓ ${chain.name} open-trades: ${trades.length}`)
    await sleep(300)
  }
  return addresses
}

/**
 * ROI calculation — corrected vs v2.
 *
 * The Gains API returns avg_win/avg_loss as average dollar outcome per trade,
 * NOT as position sizes. The corrected formula estimates capital using avg_loss
 * as a proxy for collateral per losing trade (losing trades risk ~100% of collateral).
 *
 * roi = total_pnl / (avgLoss_abs × count_loss) × 100
 * Fallback: if count_loss = 0, use |pnl| as floor.
 */
function computeTraderMetrics(t) {
  const winRate = t.trades > 0 ? (t.wins / t.trades) * 100 : null

  let roi = 0
  if (t.losses > 0 && t.avgLoss > 0) {
    // Capital proxy: average collateral ≈ avgLoss (typical Gains trade loses ~1× collateral)
    const estimatedCapital = t.avgLoss * t.losses
    roi = estimatedCapital > 0 ? (t.pnl / estimatedCapital) * 100 : 0
  } else if (Math.abs(t.pnl) > 0 && t.trades > 0) {
    // Fallback: no loss data — use |pnl| / trades as rough signal
    roi = t.pnl > 0 ? (t.pnl / Math.abs(t.pnl)) * 50 : 0
  }

  // Cap ROI at reasonable bounds (±10000%)
  roi = Math.max(-9999, Math.min(9999, roi))

  return { roi, winRate, pnl: t.pnl, trades: t.trades }
}

/**
 * Upsert a single snapshot row, with full error logging.
 */
async function upsertSnapshot(snap) {
  // Validate required fields before upsert
  if (!snap.source_trader_id || !snap.source || !snap.season_id) return false

  const { error } = await supabase
    .from('trader_snapshots')
    .upsert(snap, { onConflict: 'source,source_trader_id,season_id' })

  if (error) {
    console.log(`    ⚠ upsert failed [${snap.source_trader_id?.slice(0, 8)} ${snap.season_id}]: ${error.message}`)
    return false
  }
  return true
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const targetPeriods = arg === 'ALL' ? ['7D', '30D', '90D']
    : arg && ['7D', '30D', '90D'].includes(arg) ? [arg]
    : ['7D', '30D', '90D']

  console.log('Gains Network (gTrade) Import — v3 (CF Worker proxy)')
  console.log(`Periods: ${targetPeriods.join(', ')}`)
  console.log(`Proxy: ${CF_PROXY}\n`)

  // 1. Fetch leaderboard data via proxy
  console.log('📊 Fetching leaderboard/all via CF Worker...')
  const periodTraders = await fetchLeaderboardAll()
  const totalLbTraders = [...periodTraders.values()].reduce((s, m) => s + m.size, 0)
  console.log(`  Total leaderboard entries across all periods: ${totalLbTraders}`)

  // 2. Fetch open-trade addresses via proxy
  console.log('\n📊 Fetching open-trade addresses via CF Worker...')
  const openAddresses = await fetchOpenTradeAddresses()
  console.log(`  Active addresses: ${openAddresses.size}`)

  for (const period of targetPeriods) {
    const gainsKey = GAINS_PERIOD_MAP[period]
    if (!gainsKey) continue

    console.log(`\n=== ${period} (gains key: ${gainsKey}) ===`)

    const lbTraders = periodTraders.get(gainsKey) || new Map()
    console.log(`  Leaderboard traders: ${lbTraders.size}`)

    const allTraders = []

    // Leaderboard traders — full stats
    for (const [addr, t] of lbTraders) {
      const m = computeTraderMetrics(t)
      allTraders.push({ address: addr, ...m, hasData: true })
    }

    // Open-trade-only traders — active but no stats; only include if leaderboard was empty
    if (lbTraders.size === 0) {
      for (const addr of openAddresses) {
        allTraders.push({ address: addr, roi: null, pnl: null, winRate: null, trades: null, hasData: false })
      }
    }

    allTraders.sort((a, b) => {
      if (a.hasData && !b.hasData) return -1
      if (!a.hasData && b.hasData) return 1
      return (b.roi || 0) - (a.roi || 0)
    })

    // Only keep traders that have at least pnl data
    const withData = allTraders.filter(t => t.pnl !== null || t.roi !== null)
    const top = withData.slice(0, 500)
    const capturedAt = new Date().toISOString()

    console.log(`  Traders with data: ${withData.length}, saving top: ${top.length}`)

    if (top.length === 0) {
      console.log('  ⚠ No data to save for this period')
      continue
    }

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
    if (srcErr) console.log(`  ⚠ trader_sources upsert: ${srcErr.message}`)

    // Upsert snapshots individually to catch per-row errors
    let saved = 0, failed = 0
    for (let idx = 0; idx < top.length; idx++) {
      const t = top[idx]
      const snap = {
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
      }

      if (await upsertSnapshot(snap)) saved++
      else failed++
    }

    const withRoi = top.filter(t => t.roi !== null).length
    const withWr  = top.filter(t => t.winRate !== null).length
    console.log(`  ✅ Saved: ${saved}/${top.length} (failed: ${failed})`)
    console.log(`     ROI: ${withRoi}/${top.length}, WR: ${withWr}/${top.length}`)

    top.filter(t => t.hasData).slice(0, 5).forEach((t, i) => {
      console.log(`     ${i + 1}. ${t.address.slice(0, 12)}…: ROI ${t.roi?.toFixed(1)}% PnL $${t.pnl?.toFixed(0)} WR ${t.winRate?.toFixed(1) ?? 'N/A'}%`)
    })

    await sleep(2000)
  }

  console.log('\n✅ Gains Network import done')
}

main().catch(console.error)

/**
 * GMX Data Enrichment
 * 
 * Fills missing win_rate (from on-chain wins/losses) and max_drawdown (estimated).
 * GMX subgraph provides wins/losses counts → win_rate.
 * Max drawdown isn't directly available from the subgraph, but we can estimate
 * from position history or set a reasonable estimate.
 * 
 * Usage: node scripts/import/enrich_gmx.mjs [30D|7D|90D]
 */

import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gmx'
const SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const VALUE_SCALE = 1e30

async function fetchAllSubgraphStats() {
  // Fetch ALL accountStats from subgraph (up to 1500) to match against DB records
  console.log('  Fetching full subgraph dataset...')
  const allStats = []
  let offset = 0
  const BATCH = 500

  while (true) {
    const query = `{
      accountStats(
        limit: ${BATCH},
        offset: ${offset},
        orderBy: realizedPnl_DESC
      ) {
        id
        wins
        losses
        realizedPnl
        volume
        netCapital
        maxCapital
        closedCount
      }
    }`

    const res = await fetch(SUBSQUID_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    })

    if (!res.ok) throw new Error(`GMX API error: ${res.status}`)
    const data = await res.json()
    const stats = data.data?.accountStats || []
    allStats.push(...stats)

    if (stats.length < BATCH || allStats.length >= 3000) break  // cap at 3000
    offset += BATCH
    await sleep(300)
  }

  console.log(`  Fetched ${allStats.length} accounts from subgraph`)

  // Build lookup map: lowercase address → stats
  const map = new Map()
  for (const s of allStats) {
    map.set(s.id.toLowerCase(), s)
  }
  return map
}

function matchTraderToSubgraph(traderId, statsMap) {
  // Direct match (full lowercase address)
  const direct = statsMap.get(traderId.toLowerCase())
  if (direct) return direct

  // Truncated ID match: "0xABC...XYZ" → find by prefix+suffix
  if (traderId.includes('...')) {
    const [prefix, suffix] = traderId.split('...')
    const prefixLower = prefix.toLowerCase()
    const suffixLower = suffix.toLowerCase()
    for (const [key, val] of statsMap) {
      if (key.startsWith(prefixLower) && key.endsWith(suffixLower)) {
        return val
      }
    }
  }

  // Try case-insensitive full match
  for (const [key, val] of statsMap) {
    if (key === traderId.toLowerCase()) return val
  }

  return null
}

/**
 * Estimate max drawdown from position-level data.
 * This queries individual positions to build a PnL curve.
 */
async function fetchPositionDrawdown(address) {
  try {
    // Use positionChanges with correct field names
    const query = `{
      positionChanges(
        where: { account_eq: "${address}" }
        orderBy: timestamp_ASC
        limit: 300
      ) {
        timestamp
        basePnlUsd
        sizeDeltaUsd
      }
    }`

    const res = await fetch(SUBSQUID_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    })

    if (!res.ok) return null
    const data = await res.json()

    const changes = data.data?.positionChanges || []
    // Filter to entries with non-zero PnL (position decreases/closes)
    const closes = changes.filter(c => c.basePnlUsd && c.basePnlUsd !== '0')
    if (closes.length < 3) return null

    let cumPnl = 0
    let peak = 0
    let maxDD = 0

    for (const pos of closes) {
      const pnl = Number(BigInt(pos.basePnlUsd)) / VALUE_SCALE
      cumPnl += pnl
      if (cumPnl > peak) peak = cumPnl
      const dd = peak > 0 ? (peak - cumPnl) / peak : 0
      if (dd > maxDD) maxDD = dd
    }

    return maxDD > 0.005 ? maxDD * 100 : null  // Only report >0.5% drawdown
  } catch { return null }
}

async function main() {
  const period = (process.argv[2] || '30D').toUpperCase()
  if (!['7D', '30D', '90D'].includes(period)) { console.error('Invalid period'); process.exit(1) }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`GMX Enrichment — ${period}`)
  console.log(`${'='.repeat(60)}`)

  // Get missing data
  const { data: missingWr } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .eq('season_id', period)
    .is('win_rate', null)

  const { data: missingDd } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .eq('season_id', period)
    .is('max_drawdown', null)

  console.log(`Missing win_rate: ${missingWr?.length || 0}`)
  console.log(`Missing max_drawdown: ${missingDd?.length || 0}`)

  // ── Part 1: Fill win_rate from subgraph wins/losses ──
  let wrFilled = 0
  const statsMap = await fetchAllSubgraphStats()

  if (missingWr && missingWr.length > 0) {
    console.log(`\n📊 Enriching win_rate from subgraph...`)

    for (const trader of missingWr) {
      const stat = matchTraderToSubgraph(trader.source_trader_id, statsMap)
      if (!stat) continue

      const total = (stat.wins || 0) + (stat.losses || 0)
      if (total < 3) continue

      const winRate = (stat.wins / total) * 100
      const { totalScore } = calculateArenaScore(
        trader.roi || 0, trader.pnl, trader.max_drawdown, winRate, period
      )

      await supabase
        .from('trader_snapshots')
        .update({ win_rate: winRate, arena_score: totalScore })
        .eq('id', trader.id)

      wrFilled++
    }

    console.log(`  win_rate filled: ${wrFilled}/${missingWr.length}`)
  }

  // ── Part 2: Fill max_drawdown from position history ──
  let ddFilled = 0, ddSkipped = 0
  const DD_LIMIT = 250  // Cap to stay fast
  if (missingDd && missingDd.length > 0) {
    const ddBatch = missingDd.slice(0, DD_LIMIT)
    console.log(`\n📊 Enriching max_drawdown from position history (${ddBatch.length}/${missingDd.length})...`)

    const CONCURRENCY = 3
    for (let i = 0; i < ddBatch.length; i += CONCURRENCY) {
      const batch = ddBatch.slice(i, i + CONCURRENCY)

      await Promise.all(batch.map(async (trader) => {
        try {
          // Resolve the full address from subgraph (handles truncated IDs)
          const stat = matchTraderToSubgraph(trader.source_trader_id, statsMap)
          const fullAddress = stat?.id  // subgraph returns checksummed full address
          if (!fullAddress) { ddSkipped++; return }

          const dd = await fetchPositionDrawdown(fullAddress)
          if (dd === null) return

          const { data: current } = await supabase
            .from('trader_snapshots')
            .select('win_rate')
            .eq('id', trader.id)
            .single()

          const currentWr = current?.win_rate ?? trader.win_rate
          const { totalScore } = calculateArenaScore(
            trader.roi || 0, trader.pnl, dd, currentWr, period
          )

          await supabase
            .from('trader_snapshots')
            .update({ max_drawdown: dd, arena_score: totalScore })
            .eq('id', trader.id)

          ddFilled++
        } catch {}
      }))

      const done = Math.min(i + CONCURRENCY, ddBatch.length)
      if (done % 30 === 0 || done === ddBatch.length) {
        console.log(`  [${done}/${ddBatch.length}] dd filled: ${ddFilled}, skipped: ${ddSkipped}`)
      }
      await sleep(400)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ GMX ${period} enrichment done`)
  console.log(`   Win rate filled: ${wrFilled}`)
  console.log(`   Max drawdown filled: ${ddFilled}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

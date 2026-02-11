/**
 * GMX V2 (Synthetics) 交易员数据抓取
 * 
 * 数据源: Subsquid GraphQL API
 * URL: https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql
 * 
 * 抓取 accountStats: address, wins, losses, realizedPnl, volume, closedCount
 * 
 * Usage: node scripts/import/import_gmx_v2.mjs [7D|30D|90D|ALL]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gmx'
const SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const VALUE_SCALE = 1e30
const TARGET_COUNT = 500

async function fetchAccountStats() {
  console.log('  📊 Fetching GMX accountStats from Subsquid...')
  const allStats = []
  let offset = 0
  const BATCH = 500

  while (allStats.length < 3000) {
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
      body: JSON.stringify({ query }),
    })

    if (!res.ok) throw new Error(`GMX API error: ${res.status}`)
    const data = await res.json()
    const stats = data.data?.accountStats || []
    allStats.push(...stats)

    if (stats.length < BATCH) break
    offset += BATCH
    await sleep(500)
  }

  console.log(`  ✓ Fetched ${allStats.length} accounts`)
  return allStats
}

function parseStats(stat) {
  const realizedPnl = Number(BigInt(stat.realizedPnl || '0')) / VALUE_SCALE
  const volume = Number(BigInt(stat.volume || '0')) / VALUE_SCALE
  const netCapital = Number(BigInt(stat.netCapital || '0')) / VALUE_SCALE
  const maxCapital = Number(BigInt(stat.maxCapital || '0')) / VALUE_SCALE
  const wins = stat.wins || 0
  const losses = stat.losses || 0
  const totalTrades = wins + losses
  const closedCount = stat.closedCount || totalTrades

  // ROI = realizedPnl / maxCapital (best estimate of capital deployed)
  const capital = maxCapital > 0 ? maxCapital : (netCapital > 0 ? netCapital : volume / 10)
  const roi = capital > 0 ? (realizedPnl / capital) * 100 : 0
  const winRate = totalTrades >= 3 ? (wins / totalTrades) * 100 : null

  return {
    address: stat.id,
    roi,
    pnl: realizedPnl,
    winRate,
    totalTrades: closedCount,
    volume,
  }
}

async function processAndSave(stats, period) {
  if (stats.length === 0) return 0

  // Parse and filter
  const traders = stats
    .map(parseStats)
    .filter(t => t.totalTrades >= 3 && t.pnl !== 0)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, TARGET_COUNT)

  const capturedAt = new Date().toISOString()

  // Upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'defi',
    source_trader_id: t.address,
    handle: `${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
    profile_url: `https://app.gmx.io/#/actions/v2/${t.address}`,
    is_active: true,
  }))

  // Batch upsert sources in chunks
  for (let i = 0; i < sourcesData.length; i += 200) {
    await supabase.from('trader_sources').upsert(sourcesData.slice(i, i + 200), {
      onConflict: 'source,source_trader_id',
    })
  }

  // Upsert snapshots
  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.address,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: null,
    followers: 0,
    trades_count: t.totalTrades,
    arena_score: calculateArenaScore(t.roi || 0, t.pnl || 0, null, t.winRate, period).totalScore,
    captured_at: capturedAt,
  }))

  for (let i = 0; i < snapshotsData.length; i += 200) {
    const { error } = await supabase.from('trader_snapshots').upsert(
      snapshotsData.slice(i, i + 200),
      { onConflict: 'source,source_trader_id,season_id' }
    )
    if (error) console.log(`  ⚠ Batch ${i} error: ${error.message}`)
  }

  const withWr = traders.filter(t => t.winRate !== null).length
  console.log(`  ✓ ${period}: saved ${traders.length} traders (${withWr} with win_rate)`)
  return traders.length
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const targetPeriods = arg === 'ALL' || !arg ? ['7D', '30D', '90D'] :
    ['7D', '30D', '90D'].includes(arg) ? [arg] : ['7D', '30D', '90D']

  console.log('GMX V2 (Synthetics) 交易员数据抓取')
  console.log('数据源: Subsquid GraphQL')
  console.log('目标周期:', targetPeriods.join(', '))

  // Fetch once, reuse for all periods (subgraph is all-time data)
  const stats = await fetchAccountStats()

  if (stats.length > 0) {
    const sample = parseStats(stats[0])
    console.log(`\n  TOP 1: ${sample.address.slice(0,10)}... PnL $${sample.pnl.toFixed(2)}, ROI ${sample.roi.toFixed(2)}%, Trades ${sample.totalTrades}`)
  }

  for (const period of targetPeriods) {
    console.log(`\n=== ${period} ===`)
    await processAndSave(stats, period)
    await sleep(1000)
  }

  console.log('\n✅ GMX V2 完成')
}

main().catch(console.error)

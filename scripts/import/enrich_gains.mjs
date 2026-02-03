/**
 * Gains Network enrichment script
 * 
 * 问题：676条记录只有地址（从open-trades导入），没有ROI/WR/PnL
 * 方案：从 /leaderboard API 获取完整数据，更新已有记录
 * 
 * 用法: node scripts/import/enrich_gains.mjs [30D]
 */
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const API_BASE = 'https://backend-arbitrum.gains.trade'

async function main() {
  const period = process.argv[2]?.toUpperCase() || '30D'
  console.log(`\n=== Gains Network Enrichment — ${period} ===`)

  // 1. Get existing records missing data
  const { data: missing, count } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate', { count: 'exact' })
    .eq('source', 'gains')
    .eq('season_id', period)
    .or('roi.is.null,win_rate.is.null,pnl.is.null')
  
  console.log(`Records missing data: ${count}`)

  // 2. Fetch leaderboard
  console.log('Fetching /leaderboard...')
  const res = await fetch(`${API_BASE}/leaderboard`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      'Accept': 'application/json',
    }
  })
  
  if (!res.ok) {
    console.error(`Leaderboard fetch failed: ${res.status}`)
    process.exit(1)
  }
  
  const leaderboard = await res.json()
  console.log(`Leaderboard has ${leaderboard.length} traders`)

  // Build lookup map by address (lowercase)
  const lbMap = new Map()
  for (const t of leaderboard) {
    lbMap.set(t.address.toLowerCase(), t)
  }

  // 3. Update missing records
  let updated = 0
  let matched = 0
  let noMatch = 0

  for (const snap of missing) {
    const addr = snap.source_trader_id.toLowerCase()
    const lb = lbMap.get(addr)
    
    if (!lb) {
      noMatch++
      continue
    }
    
    matched++
    const totalTrades = parseInt(lb.count || 0)
    const wins = parseInt(lb.count_win || 0)
    const totalPnl = parseFloat(lb.total_pnl_usd || lb.total_pnl || 0)
    const avgWin = parseFloat(lb.avg_win || 0)
    const avgLoss = Math.abs(parseFloat(lb.avg_loss || 0))
    
    // Estimate ROI
    const avgPositionSize = (avgWin + avgLoss) / 2
    const estimatedCapital = avgPositionSize > 0 ? avgPositionSize * totalTrades : Math.abs(totalPnl)
    const roi = estimatedCapital > 0 ? (totalPnl / estimatedCapital) * 100 : 0
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null

    const updates = {}
    if (snap.roi == null && roi !== null) updates.roi = roi
    if (snap.pnl == null && totalPnl !== null) updates.pnl = totalPnl
    if (snap.win_rate == null && winRate !== null) updates.win_rate = winRate
    updates.trades_count = totalTrades

    // Recalculate arena_score
    const score = calculateArenaScore(
      updates.roi ?? snap.roi ?? 0,
      updates.pnl ?? snap.pnl ?? 0,
      null, // max_drawdown not available from Gains
      updates.win_rate ?? snap.win_rate,
      period
    )
    updates.arena_score = score.totalScore

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase.from('trader_snapshots')
        .update(updates)
        .eq('id', snap.id)
      
      if (!error) updated++
      else console.warn(`  Failed to update ${snap.id}: ${error.message}`)
    }
  }

  console.log(`\nResults:`)
  console.log(`  Matched in leaderboard: ${matched}`)
  console.log(`  Not in leaderboard: ${noMatch}`)
  console.log(`  Updated: ${updated}`)

  // 4. Also delete records that have absolutely no data and weren't found in leaderboard
  // These are open-trade-only addresses with no value
  const { data: junk } = await supabase.from('trader_snapshots')
    .select('id', { count: 'exact' })
    .eq('source', 'gains')
    .eq('season_id', period)
    .is('roi', null)
    .is('pnl', null)
    .is('win_rate', null)
  
  if (junk?.length > 0) {
    console.log(`\nFound ${junk.length} Gains records with no data at all — cleaning up...`)
    const ids = junk.map(r => r.id)
    const { error } = await supabase.from('trader_snapshots').delete().in('id', ids)
    if (!error) console.log(`  Deleted ${ids.length} empty Gains records`)
    else console.error(`  Delete error: ${error.message}`)
  }

  // Verify
  const { count: remaining } = await supabase.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'gains')
    .eq('season_id', period)
  const { count: stillMissing } = await supabase.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'gains')
    .eq('season_id', period)
    .or('roi.is.null,win_rate.is.null,pnl.is.null')
  
  console.log(`\nFinal: ${remaining} total, ${stillMissing} still missing data`)
}

main().catch(console.error)

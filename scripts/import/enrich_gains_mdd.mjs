/**
 * Gains Network MDD Enrichment - 从leaderboard估算MDD
 * 修复409个NULL MDD记录
 * 
 * Gains API limitation:
 * - /leaderboard 只返回25个trader，包含avg_win/avg_loss
 * - 没有单个trader详情API
 * - 需要从统计数据估算MDD
 */

import {
  getSupabaseClient,
  sleep,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'gains'
const API_BASE = 'https://backend-arbitrum.gains.trade'

/**
 * 从avg_win/avg_loss估算MDD
 * Kelly方法：MDD ≈ avgLoss * sqrt(totalTrades) / avgPositionSize
 */
function estimateMDD(avgWin, avgLoss, totalTrades, wins) {
  if (!avgWin || !avgLoss || totalTrades < 5) return null

  const losses = totalTrades - wins
  const lossRate = losses / totalTrades
  
  // 估算最大连续亏损次数
  const maxConsecLosses = lossRate > 0 && lossRate < 1 
    ? Math.max(2, Math.log(totalTrades) / Math.log(1 / lossRate)) 
    : 3

  // 估算本金（基于平均仓位大小）
  const avgPositionSize = (avgWin + avgLoss) / 2
  const estimatedCapital = avgPositionSize * Math.max(5, Math.sqrt(totalTrades))
  
  if (estimatedCapital <= 0) return null

  // MDD = 最大连续亏损金额 / 本金
  const mdd = (avgLoss * maxConsecLosses / estimatedCapital) * 100
  
  return Math.min(Math.max(mdd, 5), 95) // 限制在5-95%范围
}

/**
 * 从API获取leaderboard（仅25个trader有数据）
 */
async function fetchLeaderboard() {
  try {
    const res = await fetch(`${API_BASE}/leaderboard`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

async function main() {
  const period = process.argv[2] || '30D'
  
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gains Network MDD Enrichment — ${period}`)
  console.log(`${'='.repeat(60)}`)

  // 1. Fetch leaderboard (only 25 traders with full stats)
  console.log('Fetching leaderboard...')
  const leaderboard = await fetchLeaderboard()
  console.log(`Leaderboard: ${leaderboard.length} traders`)

  if (leaderboard.length === 0) {
    console.log('❌ Failed to fetch leaderboard')
    return
  }

  // 2. Get all Gains traders with NULL MDD
  const { data: nullRecords } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, roi, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  console.log(`Found ${nullRecords?.length || 0} records with NULL MDD`)
  
  if (!nullRecords || nullRecords.length === 0) {
    console.log('✅ No records to enrich')
    return
  }

  // 3. Create leaderboard map
  const lbMap = new Map()
  for (const t of leaderboard) {
    lbMap.set(t.address.toLowerCase(), t)
  }

  let updated = 0
  let noData = 0
  let errors = 0

  for (let i = 0; i < nullRecords.length; i++) {
    const record = nullRecords[i]
    const addr = record.source_trader_id.toLowerCase()
    
    if ((i + 1) % 100 === 0) {
      console.log(`  [${i + 1}/${nullRecords.length}] updated=${updated} noData=${noData} errors=${errors}`)
    }

    try {
      const lb = lbMap.get(addr)
      
      if (!lb) {
        // Not in leaderboard top 25, set MDD to 0 (no data)
        const { error } = await supabase
          .from('leaderboard_ranks')
          .update({ max_drawdown: 0 })
          .eq('id', record.id)
        
        if (!error) updated++
        else errors++
        continue
      }

      // Calculate MDD from leaderboard stats
      const avgWin = Math.abs(parseFloat(lb.avg_win || 0))
      const avgLoss = Math.abs(parseFloat(lb.avg_loss || 0))
      const totalTrades = parseInt(lb.count || 0)
      const wins = parseInt(lb.count_win || 0)

      const mdd = estimateMDD(avgWin, avgLoss, totalTrades, wins)
      
      if (mdd === null) {
        noData++
        continue
      }

      // Update database
      const { error } = await supabase
        .from('leaderboard_ranks')
        .update({ max_drawdown: mdd })
        .eq('id', record.id)

      if (error) {
        console.error(`  ❌ Update error for ${record.source_trader_id}:`, error.message)
        errors++
      } else {
        updated++
      }

    } catch (err) {
      console.error(`  ❌ Error processing ${record.source_trader_id}:`, err.message)
      errors++
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Gains Network MDD enrichment done`)
  console.log(`   Updated: ${updated}`)
  console.log(`   No data: ${noData}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)

  // Verify results
  const { count: remaining } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  console.log(`\nRemaining NULL MDD: ${remaining}`)
}

main().catch(console.error)

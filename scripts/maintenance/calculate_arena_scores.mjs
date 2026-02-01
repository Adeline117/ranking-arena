#!/usr/bin/env node
/**
 * Arena Score 计算脚本 (优化版)
 * 为所有 trader_snapshots 计算并更新 arena_score
 */

import {
  getSupabaseClient,
  calculateArenaScore as _calcScore,
  normalizeWinRate,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

/**
 * Wrapper: shared.mjs calculateArenaScore expects (roi, pnl, mdd, winRate, period),
 * but this script feeds snapshot rows from the database.
 */
function calculateArenaScore(snap, period) {
  const roi = parseFloat(snap.roi) || 0
  const pnl = parseFloat(snap.pnl) || 0
  const mdd = snap.max_drawdown !== null ? parseFloat(snap.max_drawdown) : null
  const wr = snap.win_rate !== null ? normalizeWinRate(parseFloat(snap.win_rate)) : null
  return _calcScore(roi, pnl, mdd, wr, period)
}

// ============================================
// 主函数
// ============================================

async function main() {
  const targetSource = process.argv[2] || 'binance_futures'
  console.log(`\n🚀 Arena Score 计算 - ${targetSource}`)
  console.log(`时间: ${new Date().toISOString()}\n`)
  
  const sources = targetSource === 'all' 
    ? ['binance_futures', 'binance_spot', 'bybit', 'bitget_futures', 'bitget_spot', 'okx_web3', 'binance_web3', 'coinex', 'gmx', 'kucoin', 'mexc']
    : [targetSource]
  
  let totalUpdated = 0
  
  for (const source of sources) {
    console.log(`\n📊 ${source}`)
    
    for (const period of ['7D', '30D', '90D']) {
      // 获取所有 snapshots
      const { data: snapshots, error } = await supabase
        .from('trader_snapshots')
        .select('id, roi, pnl, max_drawdown, win_rate')
        .eq('source', source)
        .eq('season_id', period)
      
      if (error || !snapshots?.length) {
        console.log(`  ${period}: ${error?.message || '无数据'}`)
        continue
      }
      
      // 批量计算并更新
      let updated = 0
      const batchSize = 50
      
      for (let i = 0; i < snapshots.length; i += batchSize) {
        const batch = snapshots.slice(i, i + batchSize)
        const promises = batch.map(async snap => {
          const score = calculateArenaScore(snap, period)
          const { error } = await supabase
            .from('trader_snapshots')
            .update({ arena_score: score })
            .eq('id', snap.id)
          return error ? 0 : 1
        })
        
        const results = await Promise.all(promises)
        updated += results.reduce((a, b) => a + b, 0)
      }
      
      // 获取 TOP 5
      const { data: top5 } = await supabase
        .from('trader_snapshots')
        .select('arena_score')
        .eq('source', source)
        .eq('season_id', period)
        .order('arena_score', { ascending: false })
        .limit(5)
      
      const topScores = top5?.map(t => t.arena_score?.toFixed(1)).join(', ') || '-'
      console.log(`  ${period}: ${updated}/${snapshots.length} 已更新, TOP5: [${topScores}]`)
      totalUpdated += updated
    }
  }
  
  console.log(`\n✅ 完成！共更新 ${totalUpdated} 条记录`)
}

main().catch(console.error)

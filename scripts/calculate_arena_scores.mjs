#!/usr/bin/env node
/**
 * Arena Score 计算脚本 (优化版)
 * 为所有 trader_snapshots 计算并更新 arena_score
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ 缺少环境变量')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ============================================
// Arena Score 计算逻辑
// ============================================

const ARENA_CONFIG = {
  PNL_THRESHOLD: { '7D': 300, '30D': 1000, '90D': 3000 },
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  WIN_RATE_BASELINE: 45,
  MAX_RETURN_SCORE: 85,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
}

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90

function calculateArenaScore(snap, period) {
  const roi = parseFloat(snap.roi) || 0
  const pnl = parseFloat(snap.pnl) || 0
  const mdd = snap.max_drawdown !== null ? parseFloat(snap.max_drawdown) : null
  let wr = snap.win_rate !== null ? parseFloat(snap.win_rate) : null
  
  // 标准化 win_rate：如果 <= 1 则认为是小数，需要乘以 100
  if (wr !== null && wr <= 1) {
    wr = wr * 100
  }
  
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = getPeriodDays(period)
  
  // Return score
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85) : 0
  
  // Drawdown score
  const drawdownScore = mdd !== null 
    ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(mdd) / params.mddThreshold, 0, 1), 0, 8)
    : 4
  
  // Stability score
  const stabilityScore = wr !== null
    ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7)
    : 3.5
  
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
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

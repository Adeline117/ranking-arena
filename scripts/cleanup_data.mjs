#!/usr/bin/env node
/**
 * 数据库清理脚本
 * 1. 统一 source 命名 (binance -> binance_futures)
 * 2. 标准化 win_rate 格式 (小数 -> 百分比)
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function cleanupSources() {
  console.log('\n📦 1. 统一 source 命名...')
  
  // 获取 binance 和 binance_futures 的交易员 ID
  const { data: binanceSources } = await supabase
    .from('trader_sources')
    .select('source_trader_id')
    .eq('source', 'binance')
  
  const { data: futuresSources } = await supabase
    .from('trader_sources')
    .select('source_trader_id')
    .eq('source', 'binance_futures')
  
  const futuresIds = new Set(futuresSources?.map(s => s.source_trader_id))
  const toUpdate = binanceSources?.filter(s => !futuresIds.has(s.source_trader_id)) || []
  const duplicates = binanceSources?.filter(s => futuresIds.has(s.source_trader_id)) || []
  
  console.log(`   binance 记录: ${binanceSources?.length || 0}`)
  console.log(`   需要更新: ${toUpdate.length}`)
  console.log(`   重复记录: ${duplicates.length}`)
  
  // 更新非重复的记录
  if (toUpdate.length > 0) {
    const updateIds = toUpdate.map(s => s.source_trader_id)
    const { error } = await supabase
      .from('trader_sources')
      .update({ source: 'binance_futures' })
      .eq('source', 'binance')
      .in('source_trader_id', updateIds)
    
    if (error) console.log(`   ❌ 更新错误: ${error.message}`)
    else console.log(`   ✓ 更新了 ${toUpdate.length} 条 trader_sources`)
  }
  
  // 删除重复记录
  if (duplicates.length > 0) {
    const dupIds = duplicates.map(s => s.source_trader_id)
    const { error } = await supabase
      .from('trader_sources')
      .delete()
      .eq('source', 'binance')
      .in('source_trader_id', dupIds)
    
    if (error) console.log(`   ❌ 删除错误: ${error.message}`)
    else console.log(`   ✓ 删除了 ${duplicates.length} 条重复记录`)
  }
  
  // 更新 trader_snapshots 中的 source
  console.log('\n   更新 trader_snapshots 的 source...')
  const { data: updated, error } = await supabase
    .from('trader_snapshots')
    .update({ source: 'binance_futures' })
    .eq('source', 'binance')
    .select('id')
  
  if (error) console.log(`   ❌ 错误: ${error.message}`)
  else console.log(`   ✓ 更新了 ${updated?.length || 0} 条 trader_snapshots`)
}

async function standardizeWinRate() {
  console.log('\n📊 2. 标准化 win_rate...')
  
  // 分批处理，每批 500 条
  const BATCH_SIZE = 500
  let totalConverted = 0
  let hasMore = true
  
  while (hasMore) {
    const { data: records, error } = await supabase
      .from('trader_snapshots')
      .select('id, win_rate')
      .not('win_rate', 'is', null)
      .lt('win_rate', 1)
      .limit(BATCH_SIZE)
    
    if (error) {
      console.log(`   ❌ 查询错误: ${error.message}`)
      break
    }
    
    if (!records || records.length === 0) {
      hasMore = false
      break
    }
    
    // 批量更新
    const updates = records.map(r => ({
      id: r.id,
      win_rate: r.win_rate * 100
    }))
    
    // 使用 Promise.all 并行更新
    const results = await Promise.all(
      updates.map(u => 
        supabase
          .from('trader_snapshots')
          .update({ win_rate: u.win_rate })
          .eq('id', u.id)
      )
    )
    
    const successCount = results.filter(r => !r.error).length
    totalConverted += successCount
    console.log(`   批次完成: ${successCount}/${records.length}`)
    
    if (records.length < BATCH_SIZE) {
      hasMore = false
    }
  }
  
  console.log(`   ✓ 共转换 ${totalConverted} 条 win_rate 记录`)
}

async function verify() {
  console.log('\n🔍 验证结果...')
  
  const { count: binanceCount } = await supabase
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'binance')
  
  const { count: snapshotBinanceCount } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'binance')
  
  const { count: smallWinRate } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .not('win_rate', 'is', null)
    .lt('win_rate', 1)
  
  console.log(`   trader_sources 中 binance: ${binanceCount}`)
  console.log(`   trader_snapshots 中 binance: ${snapshotBinanceCount}`)
  console.log(`   win_rate < 1 的记录: ${smallWinRate}`)
  
  if (binanceCount === 0 && snapshotBinanceCount === 0 && smallWinRate === 0) {
    console.log('\n✅ 数据清理完成！')
    return true
  } else {
    console.log('\n⚠️ 仍有数据需要处理')
    return false
  }
}

async function main() {
  console.log('🧹 开始数据库清理...')
  console.log(`时间: ${new Date().toISOString()}`)
  
  await cleanupSources()
  await standardizeWinRate()
  await verify()
}

main().catch(console.error)

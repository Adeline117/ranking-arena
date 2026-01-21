#!/usr/bin/env node
/**
 * 数据验证工具
 * 
 * 检查项目:
 * 1. Source 命名一致性（不应有旧的 'binance' source）
 * 2. Win Rate 格式（应为百分比格式，不是小数）
 * 3. Arena Score 覆盖率
 * 4. 数据新鲜度
 * 
 * 用法: node scripts/validate_data.mjs [--fix]
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

const FIX_MODE = process.argv.includes('--fix')

// 有效的 source 列表
const VALID_SOURCES = [
  'binance_futures',
  'binance_spot',
  'binance_web3',
  'bitget_futures',
  'bitget_spot',
  'bybit',
  'mexc',
  'coinex',
  'okx_web3',
  'kucoin',
  'gmx',
]

let hasErrors = false

async function checkSourceNaming() {
  console.log('\n📋 1. 检查 Source 命名一致性...')
  
  // 检查 trader_sources
  const { data: sources } = await supabase
    .from('trader_sources')
    .select('source')
  
  const invalidSourcesSources = sources?.filter(s => !VALID_SOURCES.includes(s.source)) || []
  const uniqueInvalid = [...new Set(invalidSourcesSources.map(s => s.source))]
  
  if (uniqueInvalid.length > 0) {
    console.log(`   ❌ trader_sources 中发现无效 source: ${uniqueInvalid.join(', ')}`)
    console.log(`      数量: ${invalidSourcesSources.length}`)
    hasErrors = true
    
    if (FIX_MODE) {
      // 尝试修复 'binance' -> 'binance_futures'
      if (uniqueInvalid.includes('binance')) {
        console.log('   🔧 尝试修复: binance -> binance_futures')
        await supabase
          .from('trader_sources')
          .update({ source: 'binance_futures' })
          .eq('source', 'binance')
      }
    }
  } else {
    console.log('   ✓ trader_sources source 命名正确')
  }
  
  // 检查 trader_snapshots
  const { data: snapshots } = await supabase
    .from('trader_snapshots')
    .select('source')
    .limit(10000)
  
  const invalidSourcesSnapshots = snapshots?.filter(s => !VALID_SOURCES.includes(s.source)) || []
  const uniqueInvalidSnap = [...new Set(invalidSourcesSnapshots.map(s => s.source))]
  
  if (uniqueInvalidSnap.length > 0) {
    console.log(`   ❌ trader_snapshots 中发现无效 source: ${uniqueInvalidSnap.join(', ')}`)
    console.log(`      数量: ${invalidSourcesSnapshots.length}`)
    hasErrors = true
    
    if (FIX_MODE) {
      if (uniqueInvalidSnap.includes('binance')) {
        console.log('   🔧 尝试修复: binance -> binance_futures')
        await supabase
          .from('trader_snapshots')
          .update({ source: 'binance_futures' })
          .eq('source', 'binance')
      }
      if (uniqueInvalidSnap.includes('bitget')) {
        console.log('   🔧 尝试修复: bitget -> bitget_futures')
        await supabase
          .from('trader_snapshots')
          .update({ source: 'bitget_futures' })
          .eq('source', 'bitget')
      }
    }
  } else {
    console.log('   ✓ trader_snapshots source 命名正确')
  }
}

async function checkWinRateFormat() {
  console.log('\n📊 2. 检查 Win Rate 格式...')
  
  // 检查 0 < win_rate < 1 的记录（应为百分比）
  const { count: decimalCount } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .gt('win_rate', 0)
    .lt('win_rate', 1)
  
  if (decimalCount > 0) {
    console.log(`   ❌ 发现 ${decimalCount} 条 win_rate 为小数格式 (0 < win_rate < 1)`)
    hasErrors = true
    
    if (FIX_MODE) {
      console.log('   🔧 转换为百分比格式...')
      const { data: records } = await supabase
        .from('trader_snapshots')
        .select('id, win_rate')
        .gt('win_rate', 0)
        .lt('win_rate', 1)
        .limit(1000)
      
      let fixed = 0
      for (const r of records || []) {
        await supabase
          .from('trader_snapshots')
          .update({ win_rate: r.win_rate * 100 })
          .eq('id', r.id)
        fixed++
      }
      console.log(`   ✓ 已转换 ${fixed} 条记录`)
    }
  } else {
    console.log('   ✓ win_rate 格式正确（百分比）')
  }
}

async function checkArenaScoreCoverage() {
  console.log('\n🎯 3. 检查 Arena Score 覆盖率...')
  
  const { count: totalCount } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
  
  const { count: hasScoreCount } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .not('arena_score', 'is', null)
  
  const coverage = ((hasScoreCount / totalCount) * 100).toFixed(1)
  
  console.log(`   总记录数: ${totalCount}`)
  console.log(`   有 Arena Score: ${hasScoreCount}`)
  console.log(`   覆盖率: ${coverage}%`)
  
  if (coverage < 90) {
    console.log(`   ⚠️ Arena Score 覆盖率较低`)
    hasErrors = true
    
    if (FIX_MODE) {
      console.log('   💡 建议运行: node scripts/calculate_arena_scores.mjs')
    }
  } else {
    console.log('   ✓ Arena Score 覆盖率良好')
  }
}

async function checkDataFreshness() {
  console.log('\n⏰ 4. 检查数据新鲜度...')
  
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  
  for (const source of ['binance_futures', 'bybit', 'bitget_futures']) {
    const { data: latest } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', source)
      .order('captured_at', { ascending: false })
      .limit(1)
    
    if (latest?.[0]) {
      const lastUpdate = new Date(latest[0].captured_at)
      const hoursSince = ((Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60)).toFixed(1)
      const isStale = lastUpdate.toISOString() < oneDayAgo
      
      console.log(`   ${source}: 最后更新 ${hoursSince} 小时前 ${isStale ? '⚠️' : '✓'}`)
      if (isStale) hasErrors = true
    } else {
      console.log(`   ${source}: 无数据 ❌`)
      hasErrors = true
    }
  }
}

async function printSummary() {
  console.log('\n' + '='.repeat(50))
  
  if (hasErrors) {
    console.log('❌ 发现数据问题')
    if (!FIX_MODE) {
      console.log('   运行 node scripts/validate_data.mjs --fix 尝试自动修复')
    }
    process.exit(1)
  } else {
    console.log('✅ 数据验证通过')
    process.exit(0)
  }
}

async function main() {
  console.log('🔍 数据验证工具')
  console.log('='.repeat(50))
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`模式: ${FIX_MODE ? '修复模式' : '检查模式'}`)
  
  await checkSourceNaming()
  await checkWinRateFormat()
  await checkArenaScoreCoverage()
  await checkDataFreshness()
  await printSummary()
}

main().catch(console.error)

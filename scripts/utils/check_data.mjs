/**
 * 检查数据库中的数据分布和一致性
 * 
 * 验证项目：
 * 1. season_id 是否有 NULL 值（应该全部为 7D/30D/90D）
 * 2. 各交易所数据是否存在及时效性
 * 3. 同一交易员在不同周期的数据是否独立
 * 4. 数据重复检测
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// 支持的交易所
const ALL_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'mexc', 'coinex']

async function main() {
  console.log('=== 数据一致性检查 ===\n')
  
  let hasIssues = false

  // 1. 检查 season_id 是否有 NULL 值
  console.log('1. 检查 season_id 是否有 NULL 值...')
  const { count: nullSeasonCount, error: nullError } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .is('season_id', null)
  
  if (nullError) {
    console.log(`   ❌ 查询失败: ${nullError.message}`)
    hasIssues = true
  } else if (nullSeasonCount && nullSeasonCount > 0) {
    console.log(`   ⚠️ 发现 ${nullSeasonCount} 条 season_id 为 NULL 的记录`)
    console.log('      建议运行: UPDATE trader_snapshots SET season_id = \'90D\' WHERE season_id IS NULL;')
    hasIssues = true
  } else {
    console.log('   ✅ 所有记录都有 season_id')
  }

  // 2. 检查 season_id 分布
  console.log('\n2. 检查 season_id 分布...')
  const { data: seasonDist } = await supabase
    .from('trader_snapshots')
    .select('season_id')
  
  if (seasonDist) {
    const distribution = {}
    seasonDist.forEach(row => {
      const key = row.season_id || 'NULL'
      distribution[key] = (distribution[key] || 0) + 1
    })
    console.log('   分布情况:')
    Object.entries(distribution).forEach(([season, count]) => {
      console.log(`   - ${season}: ${count} 条`)
    })
  }

  // 3. 检查各交易所数据时效性
  console.log('\n3. 检查各交易所数据时效性...')
  
  for (const source of ALL_SOURCES) {
    for (const period of ['7D', '30D', '90D']) {
      const { data: latestData } = await supabase
        .from('trader_snapshots')
        .select('captured_at, source_trader_id')
        .eq('source', source)
        .eq('season_id', period)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (!latestData) {
        console.log(`   ⚠️ ${source.padEnd(12)} ${period}: 无数据`)
      } else {
        const capturedAt = new Date(latestData.captured_at)
        const now = new Date()
        const hoursAgo = Math.round((now - capturedAt) / (1000 * 60 * 60))
        const status = hoursAgo > 24 ? '⚠️ 陈旧' : '✅'
        console.log(`   ${status} ${source.padEnd(12)} ${period}: ${hoursAgo}h 前更新`)
      }
    }
  }

  // 4. 检查数据重复
  console.log('\n4. 检查数据重复（同一快照时间点的重复记录）...')
  
  const { data: duplicateCheck } = await supabase.rpc('check_duplicate_snapshots')
    .select('*')
    .limit(1)
  
  // 如果 RPC 不存在，使用替代查询
  if (!duplicateCheck) {
    // 手动检查：获取一个示例交易员的数据
    const { data: sampleTrader } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, season_id, captured_at')
      .eq('source', 'binance')
      .eq('season_id', '90D')
      .order('captured_at', { ascending: false })
      .limit(10)
    
    if (sampleTrader && sampleTrader.length > 0) {
      const traderId = sampleTrader[0].source_trader_id
      const capturedAt = sampleTrader[0].captured_at
      
      const { count: dupCount } = await supabase
        .from('trader_snapshots')
        .select('*', { count: 'exact', head: true })
        .eq('source', 'binance')
        .eq('source_trader_id', traderId)
        .eq('season_id', '90D')
        .eq('captured_at', capturedAt)
      
      if (dupCount && dupCount > 1) {
        console.log(`   ⚠️ 发现重复: trader ${traderId} 在 ${capturedAt} 有 ${dupCount} 条记录`)
        hasIssues = true
      } else {
        console.log('   ✅ 抽样检查未发现重复')
      }
    }
  }

  // 5. 检查同一交易员在不同周期的数据差异
  console.log('\n5. 检查同一交易员在不同周期的数据差异...')
  
  const { data: sampleForPeriods } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'binance')
    .eq('season_id', '90D')
    .order('roi', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (sampleForPeriods) {
    const traderId = sampleForPeriods.source_trader_id
    console.log(`   检查交易员: ${traderId}`)
    
    for (const period of ['7D', '30D', '90D']) {
      const { data: periodData } = await supabase
        .from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown, captured_at')
        .eq('source', 'binance')
        .eq('source_trader_id', traderId)
        .eq('season_id', period)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (periodData) {
        console.log(`   - ${period}: ROI=${periodData.roi?.toFixed(2)}%, PnL=$${periodData.pnl?.toFixed(2)}, WinRate=${periodData.win_rate?.toFixed(1)}%`)
      } else {
        console.log(`   - ${period}: 无数据`)
      }
    }
  }

  // 汇总
  console.log('\n=== 检查完成 ===')
  if (hasIssues) {
    console.log('⚠️ 发现问题，请查看上述警告信息')
    process.exit(1)
  } else {
    console.log('✅ 数据一致性检查通过')
  }
}

main().catch(console.error)

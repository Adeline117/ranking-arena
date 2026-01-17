/**
 * 检查数据库中的数据分布
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  console.log('=== 检查数据库数据 ===\n')

  // 1. 获取一个示例交易员
  console.log('1. 获取示例交易员...')
  const { data: sample } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id, season_id, roi, pnl, win_rate')
    .eq('source', 'binance')
    .order('captured_at', { ascending: false })
    .limit(3)

  console.log('   示例数据:')
  sample?.forEach(s => {
    console.log(`   - trader: ${s.source_trader_id}, season: ${s.season_id}, roi: ${s.roi}%, pnl: ${s.pnl}`)
  })

  // 2. 检查是否有同一交易员在不同周期的数据
  if (sample && sample.length > 0) {
    const traderId = sample[0].source_trader_id
    console.log(`\n2. 检查交易员 ${traderId} 在各周期的数据...`)
    
    const { data: allPeriods } = await supabase
      .from('trader_snapshots')
      .select('season_id, roi, pnl, win_rate, captured_at')
      .eq('source', 'binance')
      .eq('source_trader_id', traderId)
      .order('captured_at', { ascending: false })

    console.log('   各周期数据:')
    const byPeriod = {}
    allPeriods?.forEach(p => {
      if (!byPeriod[p.season_id]) {
        byPeriod[p.season_id] = p
      }
    })
    
    Object.entries(byPeriod).forEach(([period, data]) => {
      console.log(`   ${period}: ROI=${data.roi}%, PnL=${data.pnl}, WinRate=${data.win_rate}`)
    })
  }

  // 3. 检查 trader_sources 表
  console.log('\n3. 检查 trader_sources 表...')
  const { data: sources } = await supabase
    .from('trader_sources')
    .select('source, source_trader_id, handle')
    .eq('source', 'binance')
    .limit(5)
  
  console.log('   示例交易员来源:')
  sources?.forEach(s => {
    console.log(`   - ${s.handle} (ID: ${s.source_trader_id})`)
  })

  console.log('\n✅ 检查完成!')
}

main()

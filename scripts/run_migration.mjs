/**
 * 运行数据库迁移：添加 season_id 唯一约束
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  console.log('=== 运行数据库迁移 ===\n')

  try {
    // 1. 为没有 season_id 的旧数据设置默认值为 '90D'
    console.log('1. 更新旧数据的 season_id...')
    const { error: updateError, count } = await supabase
      .from('trader_snapshots')
      .update({ season_id: '90D' })
      .is('season_id', null)
      .select('*', { count: 'exact', head: true })

    if (updateError) {
      console.log(`   ⚠ 更新失败（可能没有需要更新的数据）: ${updateError.message}`)
    } else {
      console.log(`   ✓ 更新完成`)
    }

    // 2. 检查当前 season_id 分布
    console.log('\n2. 检查 season_id 分布...')
    
    // 使用普通查询获取 season_id 分布
    const { data: snapshots } = await supabase
      .from('trader_snapshots')
      .select('season_id')
    
    const dist = {}
    snapshots?.forEach(s => {
      const sid = s.season_id || 'null'
      dist[sid] = (dist[sid] || 0) + 1
    })
    
    const distribution = Object.entries(dist).map(([season_id, count]) => ({ season_id, count }))

    if (distribution) {
      console.log('   Season ID 分布:')
      distribution.forEach(({ season_id, count }) => {
        console.log(`     ${season_id || 'null'}: ${count} 条记录`)
      })
    }

    console.log('\n✅ 迁移完成!')
    console.log('\n注意: 唯一约束需要在 Supabase Dashboard 中手动添加，或者通过 supabase db push 命令执行')
    console.log('SQL 脚本位置: supabase/migrations/00003_add_season_id_constraint.sql')

  } catch (error) {
    console.error('迁移失败:', error.message)
    process.exit(1)
  }
}

main()

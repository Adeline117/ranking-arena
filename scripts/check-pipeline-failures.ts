import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)

async function checkFailures() {
  // 查询过去24小时内batch-fetch-traders任务的失败记录
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('*')
    .like('job_name', 'batch-fetch-traders%')
    .gte('started_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('started_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('Error querying pipeline_logs:', error)
    return
  }

  console.log(`\n=== 过去24小时的batch-fetch-traders任务 (共${data?.length || 0}条) ===\n`)

  // 按group分组
  const byGroup: Record<string, any[]> = {}
  data?.forEach(log => {
    const group = log.metadata?.group || 'unknown'
    if (!byGroup[group]) byGroup[group] = []
    byGroup[group].push(log)
  })

  // 统计各group的状态
  const allGroups = ['a', 'a2', 'b', 'c', 'd1', 'd2', 'e', 'f', 'g1', 'g2', 'h', 'i']
  const emptyGroups = ['d2'] // Intentionally empty groups (dydx DEAD since 2026-03)
  
  console.log('=== 所有Groups状态 ===\n')
  for (const group of allGroups) {
    const logs = byGroup[group] || []
    if (logs.length === 0) {
      if (emptyGroups.includes(group)) {
        console.log(`⚪ Group ${group}: 已废弃/空组 (intentionally empty)`)
      } else {
        console.log(`❌ Group ${group}: 无运行记录（过去24h）`)
      }
      continue
    }

    const latest = logs[0]
    const status = latest.status
    const statusIcon = status === 'completed' ? '✅' : status === 'error' ? '❌' : '⏳'
    
    console.log(`${statusIcon} Group ${group}: ${status}`)
    console.log(`   最后运行: ${latest.started_at}`)
    console.log(`   平台: ${latest.metadata?.platforms?.join(', ') || 'N/A'}`)
    
    if (status === 'error') {
      console.log(`   ❌ 错误: ${latest.error_message || 'N/A'}`)
      if (latest.metadata?.results) {
        console.log(`   详情:`)
        latest.metadata.results.forEach((r: any) => {
          if (r.status === 'error') {
            console.log(`      - ${r.platform}: ${r.error}`)
          }
        })
      }
    } else if (status === 'completed') {
      const results = latest.metadata?.results || []
      const errors = results.filter((r: any) => r.status === 'error')
      if (errors.length > 0) {
        console.log(`   ⚠️ 部分平台失败 (${errors.length}/${results.length}):`)
        errors.forEach((e: any) => {
          console.log(`      - ${e.platform}: ${e.error}`)
        })
      } else {
        console.log(`   ✅ 所有平台成功`)
      }
    }
    console.log('')
  }

  // 统计失败的groups (排除空组)
  console.log('\n=== 失败Groups汇总 ===\n')
  const failedGroups = allGroups.filter(g => {
    if (emptyGroups.includes(g)) return false // Skip intentionally empty groups
    const logs = byGroup[g]
    if (!logs || logs.length === 0) return true
    return logs[0].status === 'error'
  })
  
  const activeGroups = allGroups.filter(g => !emptyGroups.includes(g))
  console.log(`失败Groups (${failedGroups.length}/${activeGroups.length}): ${failedGroups.join(', ')}`)
}

checkFailures().catch(console.error)

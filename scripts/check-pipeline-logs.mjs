#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('🔍 检查Pipeline日志...\n')
  
  // 检查指定的失败任务
  const targetJobs = [
    'batch-enrich-30D',
    'batch-enrich-7D',
    'batch-enrich-90D',
    'batch-fetch-traders-a4',
    'batch-fetch-traders-d2'
  ]
  
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('id, job_name, status, started_at, ended_at, records_processed, metadata, error_message')
    .in('job_name', targetJobs)
    .order('started_at', { ascending: false })
    .limit(30)
  
  if (error) {
    console.error('❌ 查询失败:', error.message)
    return
  }
  
  if (!data || data.length === 0) {
    console.log('⚠️  未找到这些任务的日志记录')
    return
  }
  
  console.log(`📊 找到 ${data.length} 条日志记录\n`)
  
  // 按任务名称分组
  const byJob = {}
  for (const log of data) {
    if (!byJob[log.job_name]) {
      byJob[log.job_name] = []
    }
    byJob[log.job_name].push(log)
  }
  
  for (const [jobName, logs] of Object.entries(byJob)) {
    const latest = logs[0]
    const status = latest.status === 'success' ? '✅' : latest.status === 'running' ? '⏳' : '❌'
    console.log(`${status} ${jobName}`)
    console.log(`   最近运行: ${latest.started_at}`)
    console.log(`   状态: ${latest.status}`)
    if (latest.records_processed) {
      console.log(`   处理记录: ${latest.records_processed}`)
    }
    if (latest.error_message) {
      console.log(`   错误: ${latest.error_message.substring(0, 300)}`)
    }
    if (latest.metadata) {
      const meta = latest.metadata
      if (meta.failed) console.log(`   失败数: ${meta.failed}`)
      if (meta.succeeded) console.log(`   成功数: ${meta.succeeded}`)
      if (meta.results && Array.isArray(meta.results)) {
        const failedPlatforms = meta.results.filter(r => r.status === 'error')
        if (failedPlatforms.length > 0) {
          console.log(`   失败平台: ${failedPlatforms.map(p => p.platform).join(', ')}`)
        }
      }
    }
    console.log()
  }
  
  // 检查所有最近的失败任务
  console.log('\n🚨 最近20条失败日志：\n')
  const { data: allFailed, error: err2 } = await supabase
    .from('pipeline_logs')
    .select('job_name, started_at, status, error_message, metadata')
    .eq('status', 'failure')
    .order('started_at', { ascending: false })
    .limit(20)
  
  if (err2) {
    console.error('❌ 查询失败:', err2.message)
    return
  }
  
  if (!allFailed || allFailed.length === 0) {
    console.log('✅ 近期无失败任务')
  } else {
    for (const log of allFailed) {
      console.log(`❌ ${log.job_name}`)
      console.log(`   时间: ${log.started_at}`)
      if (log.error_message) {
        console.log(`   错误: ${log.error_message.substring(0, 200)}`)
      }
      console.log()
    }
  }
}

main().catch(console.error)

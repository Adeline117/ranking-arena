#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('🔍 检查最新错误详情...\n')
  
  // Get most recent error logs with full metadata
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('*')
    .eq('status', 'error')
    .order('started_at', { ascending: false })
    .limit(5)
  
  if (error) {
    console.error('❌ 查询失败:', error.message)
    return
  }
  
  if (!data || data.length === 0) {
    console.log('✅ 无错误日志')
    return
  }
  
  for (const log of data) {
    console.log(`\n${'='.repeat(80)}`)
    console.log(`任务: ${log.job_name}`)
    console.log(`时间: ${log.started_at}`)
    console.log(`状态: ${log.status}`)
    if (log.error_message) {
      console.log(`错误: ${log.error_message}`)
    }
    if (log.metadata) {
      console.log(`元数据:`)
      console.log(JSON.stringify(log.metadata, null, 2))
    }
  }
  console.log(`\n${'='.repeat(80)}`)
}

main().catch(console.error)

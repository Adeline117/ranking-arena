#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('🔍 检查失败的任务...\n')
  
  // 检查指定的失败任务
  const targetTasks = [
    'batch-enrich-30D',
    'batch-enrich-7D',
    'batch-enrich-90D',
    'batch-fetch-traders-a4',
    'batch-fetch-traders-d2'
  ]
  
  const { data, error } = await supabase
    .from('cron_tasks')
    .select('task_name, status, last_run, error_message, success_count, failure_count')
    .in('task_name', targetTasks)
    .order('task_name')
  
  if (error) {
    console.error('❌ 查询失败:', error.message)
    return
  }
  
  if (!data || data.length === 0) {
    console.log('⚠️  未找到这些任务的记录')
    return
  }
  
  console.log('📊 任务状态：\n')
  for (const task of data) {
    const status = task.status === 'success' ? '✅' : '❌'
    const lastRun = task.last_run ? new Date(task.last_run).toLocaleString() : 'N/A'
    console.log(`${status} ${task.task_name}`)
    console.log(`   状态: ${task.status}`)
    console.log(`   最后运行: ${lastRun}`)
    console.log(`   成功/失败: ${task.success_count || 0}/${task.failure_count || 0}`)
    if (task.error_message) {
      console.log(`   错误: ${task.error_message.substring(0, 200)}`)
    }
    console.log()
  }
  
  // 检查所有失败的任务
  console.log('\n🚨 所有失败任务：\n')
  const { data: allFailed, error: err2 } = await supabase
    .from('cron_tasks')
    .select('task_name, last_run, error_message')
    .eq('status', 'failure')
    .order('last_run', { ascending: false })
    .limit(20)
  
  if (err2) {
    console.error('❌ 查询失败:', err2.message)
    return
  }
  
  if (!allFailed || allFailed.length === 0) {
    console.log('✅ 无失败任务')
  } else {
    for (const task of allFailed) {
      console.log(`❌ ${task.task_name}`)
      console.log(`   最后运行: ${task.last_run ? new Date(task.last_run).toLocaleString() : 'N/A'}`)
      if (task.error_message) {
        console.log(`   错误: ${task.error_message.substring(0, 150)}`)
      }
      console.log()
    }
  }
}

main().catch(console.error)

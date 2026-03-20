#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('🕐 检查Enrichment任务时间线...\n')
  
  // Check last 24 hours of batch-enrich runs
  const { data, error } = await supabase
    .from('pipeline_logs')
    .select('job_name, status, started_at, ended_at')
    .like('job_name', 'batch-enrich-%')
    .gte('started_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('started_at', { ascending: false })
    .limit(20)
  
  if (error) {
    console.error('❌ 查询失败:', error.message)
    return
  }
  
  if (!data || data.length === 0) {
    console.log('⚠️  无enrichment记录')
    return
  }
  
  console.log('最近20次batch-enrich运行:\n')
  for (const log of data) {
    const startUTC = new Date(log.started_at)
    const startPDT = new Date(startUTC.getTime() - 7 * 60 * 60 * 1000) // UTC-7
    const duration = log.ended_at 
      ? Math.round((new Date(log.ended_at) - startUTC) / 1000)
      : 'running'
    
    const status = log.status === 'success' ? '✅' : log.status === 'running' ? '⏳' : '❌'
    console.log(`${status} ${log.job_name}`)
    console.log(`   开始: ${startPDT.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PDT`)
    console.log(`   UTC: ${startUTC.toISOString()}`)
    console.log(`   耗时: ${duration}s`)
    console.log()
  }
  
  // Check EMERGENCY FIX deployment time
  console.log('\n📦 EMERGENCY FIX commit时间: 2026-03-20 10:33:45 PDT (17:33:45 UTC)')
  console.log('问题发生时间: ~16:46 UTC (09:46 PDT)\n')
  console.log('⚠️  如果最近的失败在17:33 UTC之前 → 修复前的旧代码')
  console.log('✅  如果最近的失败在17:33 UTC之后 → 修复可能不够彻底\n')
}

main().catch(console.error)

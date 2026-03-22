#!/usr/bin/env node
/**
 * 检查cleanup-stuck-logs cron的运行状态
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const envPath = join(__dirname, '..', '.env')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.+)$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch (e) {}
}

loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function checkCleanupStatus() {
  console.log('🔍 检查cleanup-stuck-logs cron状态...\n')
  
  // 查询最近的cleanup-stuck-logs运行记录
  const { data: recentRuns, error } = await supabase
    .from('pipeline_logs')
    .select('*')
    .eq('job_name', 'cleanup-stuck-logs')
    .order('started_at', { ascending: false })
    .limit(10)
  
  if (error) {
    console.error('❌ 查询失败:', error)
    return
  }
  
  console.log(`📊 最近10次cleanup运行:\n`)
  
  if (!recentRuns || recentRuns.length === 0) {
    console.log('⚠️  没有找到cleanup运行记录！')
    console.log('可能原因：')
    console.log('  1. cron job从未运行过')
    console.log('  2. Vercel cron配置有问题')
    console.log('  3. 数据库记录被删除了')
    return
  }
  
  recentRuns.forEach((run, i) => {
    const age = Math.round((Date.now() - new Date(run.started_at)) / 1000 / 60)
    const duration = run.duration_ms ? `${run.duration_ms}ms` : 'N/A'
    const cleaned = run.metadata?.cleaned || run.records_processed || 0
    
    console.log(`${i + 1}. ${run.started_at} (${age}分钟前)`)
    console.log(`   状态: ${run.status} | 耗时: ${duration} | 清理: ${cleaned}个`)
    if (run.error_message) {
      console.log(`   错误: ${run.error_message}`)
    }
    console.log()
  })
  
  // 检查最近一次运行
  const latest = recentRuns[0]
  const latestAge = Math.round((Date.now() - new Date(latest.started_at)) / 1000 / 60)
  
  console.log('⏰ 状态分析:')
  
  if (latestAge > 90) {
    console.log(`  ⚠️  最近一次运行是 ${latestAge} 分钟前`)
    console.log(`  预期: 每60分钟运行一次（schedule: "7 * * * *"）`)
    console.log(`  问题: cron可能已停止运行！`)
  } else {
    console.log(`  ✅ 最近一次运行: ${latestAge}分钟前（正常）`)
  }
  
  if (latest.status === 'failed') {
    console.log(`  ❌ 最近一次运行失败！`)
    console.log(`  错误: ${latest.error_message}`)
  }
  
  // 统计最近24小时的清理量
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const last24h = recentRuns.filter(r => r.started_at >= oneDayAgo)
  const totalCleaned = last24h.reduce((sum, r) => sum + (r.metadata?.cleaned || r.records_processed || 0), 0)
  
  console.log(`\n📈 过去24小时统计:`)
  console.log(`  运行次数: ${last24h.length}`)
  console.log(`  总清理: ${totalCleaned}个stuck任务`)
  
  if (totalCleaned > 100) {
    console.log(`  ⚠️  清理量偏高！说明有任务频繁卡住`)
    console.log(`  建议: 调查enrichment任务为什么会卡住`)
  }
}

checkCleanupStatus()
  .then(() => {
    console.log('\n✅ 检查完成')
    process.exit(0)
  })
  .catch(err => {
    console.error('❌ 检查失败:', err)
    process.exit(1)
  })

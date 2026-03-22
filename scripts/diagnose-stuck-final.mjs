#!/usr/bin/env node
/**
 * 诊断stuck pipeline任务（使用正确的ended_at字段）
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

async function diagnose() {
  console.log('🔍 诊断stuck pipeline任务...\n')
  
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  
  // 查询所有stuck任务
  const { data: stuck, error, count } = await supabase
    .from('pipeline_logs')
    .select('*', { count: 'exact' })
    .eq('status', 'running')
    .lt('started_at', thirtyMinsAgo)
    .is('ended_at', null)
  
  if (error) {
    console.error('❌ 查询失败:', error)
    return
  }
  
  console.log(`📊 Stuck任务总数: ${count}`)
  console.log(`⏰ 检查时间: ${new Date().toISOString()}`)
  console.log(`⏱️  Stuck阈值: >30分钟\n`)
  
  if (count === 0) {
    console.log('✅ 没有stuck任务！')
    return { status: 'OK', stuckCount: 0 }
  }
  
  // 按job_name分组
  const byJobName = {}
  const byPlatform = {}
  let oldestTime = new Date()
  let newestTime = new Date(0)
  
  stuck.forEach(job => {
    byJobName[job.job_name] = (byJobName[job.job_name] || 0) + 1
    
    const platform = job.job_name.split('_')[0] // 例如 "bybit_futures" -> "bybit"
    byPlatform[platform] = (byPlatform[platform] || 0) + 1
    
    const startTime = new Date(job.started_at)
    if (startTime < oldestTime) oldestTime = startTime
    if (startTime > newestTime) newestTime = startTime
  })
  
  console.log('📋 按job_name分布:')
  Object.entries(byJobName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([name, count]) => {
      console.log(`  ${name.padEnd(25)} ${count}`)
    })
  
  console.log('\n🏢 按platform分布:')
  Object.entries(byPlatform)
    .sort((a, b) => b[1] - a[1])
    .forEach(([platform, count]) => {
      console.log(`  ${platform.padEnd(20)} ${count}`)
    })
  
  const ageMinutes = (Date.now() - oldestTime) / 1000 / 60
  const spanMinutes = (newestTime - oldestTime) / 1000 / 60
  
  console.log('\n⏰ 时间分析:')
  console.log(`  最早stuck任务: ${oldestTime.toISOString()} (${Math.round(ageMinutes)}分钟前)`)
  console.log(`  最晚stuck任务: ${newestTime.toISOString()}`)
  console.log(`  时间跨度: ${Math.round(spanMinutes)}分钟`)
  
  // 根因分析
  console.log('\n🔎 根因分析:')
  
  const dominantJob = Object.entries(byJobName).sort((a, b) => b[1] - a[1])[0]
  
  if (ageMinutes > 120) {
    console.log('  ⚠️  有超过2小时的老任务 → 旧任务累积，需要批量清理')
  }
  
  if (spanMinutes < 10) {
    console.log('  ⚠️  任务集中在短时间内启动 → 可能是某次deployment或批量触发')
  }
  
  if (dominantJob[1] > count * 0.5) {
    console.log(`  ⚠️  ${dominantJob[0]} 占比${(dominantJob[1]/count*100).toFixed(1)}% → 该fetcher可能有问题`)
  }
  
  // 修复方案
  console.log('\n💡 建议修复方案:')
  
  if (ageMinutes > 120) {
    console.log('  1. 立即批量kill超过2小时的任务:')
    console.log(`     UPDATE pipeline_logs SET ended_at=NOW(), status='timeout' WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL '2 hours';`)
  }
  
  console.log('  2. 批量kill所有当前stuck任务:')
  console.log(`     UPDATE pipeline_logs SET ended_at=NOW(), status='timeout' WHERE ended_at IS NULL AND started_at < '${thirtyMinsAgo}';`)
  
  console.log('\n  3. 设置自动清理cron（防止未来累积）:')
  console.log(`     每小时运行: UPDATE pipeline_logs SET ended_at=NOW(), status='auto_timeout' WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL '2 hours';`)
  
  if (dominantJob[1] > 50) {
    console.log(`\n  4. 调查${dominantJob[0]} fetcher的问题`)
    console.log(`     检查日志: grep "${dominantJob[0]}" /var/log/arena/*.log`)
  }
  
  // 显示前5个stuck任务详情
  console.log('\n📝 前5个stuck任务详情:')
  stuck.slice(0, 5).forEach(job => {
    const age = Math.round((Date.now() - new Date(job.started_at)) / 1000 / 60)
    console.log(`  ${job.job_name} - ${age}分钟前启动 - ID:${job.id}`)
  })
  
  return {
    status: 'STUCK',
    stuckCount: count,
    byJobName,
    byPlatform,
    oldestAge: Math.round(ageMinutes),
    span: Math.round(spanMinutes)
  }
}

diagnose()
  .then(result => {
    console.log('\n✅ 诊断完成')
    if (result && result.status === 'STUCK') {
      console.log(`\n🚨 需要立即处理 ${result.stuckCount} 个stuck任务！`)
      process.exit(1)
    }
    process.exit(0)
  })
  .catch(err => {
    console.error('❌ 诊断失败:', err)
    process.exit(2)
  })

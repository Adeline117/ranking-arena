#!/usr/bin/env node
/**
 * 诊断stuck pipeline任务
 * 使用Supabase REST API避免连接池问题
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env
function loadEnv() {
  const envPath = join(__dirname, '..', '.env')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch (e) {
    console.error('⚠️  无法加载.env:', e.message)
  }
}

loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function diagnosePipeline() {
  console.log('🔍 诊断stuck任务...\n')
  
  // 1. 查询stuck任务数量和分布
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pipeline_jobs?status=eq.running&started_at=lt.${thirtyMinsAgo}&ended_at=is.null&select=job_name,started_at,platform`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'count=exact'
    }
  })
  
  const total = res.headers.get('content-range')?.split('/')[1] || 0
  const jobs = await res.json()
  
  console.log(`📊 Stuck任务总数: ${total}`)
  console.log(`⏰ 检查时间: ${new Date().toISOString()}`)
  console.log(`⏱️  Stuck阈值: >30分钟\n`)
  
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.log('✅ 没有stuck任务！可能是监控误报。')
    console.log(`\nAPI响应: ${JSON.stringify(jobs, null, 2).slice(0, 500)}`)
    return { status: 'OK', stuckCount: 0 }
  }
  
  // 2. 按job_name分组统计
  const byJobName = {}
  const byPlatform = {}
  jobs.forEach(job => {
    byJobName[job.job_name] = (byJobName[job.job_name] || 0) + 1
    if (job.platform) {
      byPlatform[job.platform] = (byPlatform[job.platform] || 0) + 1
    }
  })
  
  console.log('📋 按job_name分布:')
  Object.entries(byJobName)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, count]) => {
      console.log(`  ${name}: ${count}`)
    })
  
  console.log('\n🏢 按platform分布:')
  Object.entries(byPlatform)
    .sort((a, b) => b[1] - a[1])
    .forEach(([platform, count]) => {
      console.log(`  ${platform || 'NULL'}: ${count}`)
    })
  
  // 3. 时间分布分析
  const earliest = new Date(Math.min(...jobs.map(j => new Date(j.started_at))))
  const latest = new Date(Math.max(...jobs.map(j => new Date(j.started_at))))
  
  console.log('\n⏰ 时间分析:')
  console.log(`  最早stuck任务: ${earliest.toISOString()}`)
  console.log(`  最晚stuck任务: ${latest.toISOString()}`)
  console.log(`  时间跨度: ${((latest - earliest) / 1000 / 60).toFixed(1)}分钟`)
  
  // 4. 根因分析
  console.log('\n🔎 根因分析:')
  
  const age = (Date.now() - earliest) / 1000 / 60
  if (age > 120) {
    console.log('  ⚠️  有超过2小时的老任务 → 可能是旧任务累积')
  }
  
  if (latest - earliest < 10 * 60 * 1000) {
    console.log('  ⚠️  任务集中在短时间内 → 可能是批次问题或deployment')
  }
  
  const dominantJob = Object.entries(byJobName).sort((a, b) => b[1] - a[1])[0]
  if (dominantJob[1] > total * 0.8) {
    console.log(`  ⚠️  ${dominantJob[0]} 占比${(dominantJob[1]/total*100).toFixed(1)}% → 该fetcher可能有问题`)
  }
  
  console.log('\n💡 建议修复方案:')
  if (age > 120) {
    console.log('  1. 批量kill超过2小时的任务')
    console.log(`  2. 设置自动清理：UPDATE pipeline_jobs SET ended_at=NOW(), status='failed', error='Timeout cleanup' WHERE started_at < NOW() - INTERVAL '2 hours' AND ended_at IS NULL`)
  }
  
  console.log('  3. 检查数据库连接池状态（刚才psql连接超时）')
  console.log('  4. 检查是否有最近的deployment导致')
  
  return {
    status: 'STUCK',
    stuckCount: total,
    byJobName,
    byPlatform,
    earliest,
    latest
  }
}

diagnosePipeline()
  .then(result => {
    console.log('\n✅ 诊断完成')
    process.exit(result.status === 'OK' ? 0 : 1)
  })
  .catch(err => {
    console.error('❌ 诊断失败:', err)
    process.exit(2)
  })

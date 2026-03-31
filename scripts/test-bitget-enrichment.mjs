#!/usr/bin/env node
/**
 * 测试bitget_futures enrichment（单个trader）
 * 确保不会卡住
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 加载环境变量
dotenv.config({ path: resolve(__dirname, '..', '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function testBitgetEnrichment() {
  console.log('🔍 测试bitget_futures enrichment...\n')
  
  // 1. 获取一个bitget_futures的trader
  const { data: traders, error: traderError } = await supabase
    .from('trader_sources')
    .select('source_trader_id, trader_id')
    .eq('source', 'bitget_futures')
    .limit(1)
  
  if (traderError || !traders || traders.length === 0) {
    console.error('❌ 无法获取bitget_futures trader:', traderError)
    process.exit(1)
  }
  
  const testTrader = traders[0]
  console.log(`测试trader: ${testTrader.source_trader_id}`)
  console.log(`Trader ID: ${testTrader.trader_id}\n`)
  
  // 2. 检查最近的enrichment
  const { data: recentEnrich, error: enrichError } = await supabase
    .from('trader_snapshots')
    .select('created_at, pnl, win_rate, total_trades')
    .eq('trader_id', testTrader.trader_id)
    .eq('source', 'bitget_futures')
    .order('created_at', { ascending: false })
    .limit(1)
  
  if (enrichError) {
    console.error('❌ 查询enrichment错误:', enrichError)
  } else if (!recentEnrich || recentEnrich.length === 0) {
    console.log('⚠️  这个trader还没有enrichment数据')
  } else {
    const latest = recentEnrich[0]
    const age = Math.round((Date.now() - new Date(latest.created_at)) / 1000 / 60)
    console.log(`✅ 最近enrichment: ${age}分钟前`)
    console.log(`   PNL: ${latest.pnl}`)
    console.log(`   Win Rate: ${latest.win_rate}%`)
    console.log(`   Total Trades: ${latest.total_trades}`)
  }
  
  console.log('\n📊 检查近期enrichment运行情况...\n')
  
  // 3. 检查最近的bitget_futures enrichment jobs
  const { data: jobs, error: jobError } = await supabase
    .from('pipeline_logs')
    .select('*')
    .eq('job_name', 'enrich-bitget_futures')
    .order('started_at', { ascending: false })
    .limit(10)
  
  if (jobError) {
    console.error('❌ 查询jobs错误:', jobError)
    process.exit(1)
  }
  
  console.log('最近10次enrichment:\n')
  
  const successJobs = []
  const timeoutJobs = []
  const runningJobs = []
  
  jobs.forEach((job, i) => {
    const startedAt = new Date(job.started_at)
    const endedAt = job.ended_at ? new Date(job.ended_at) : null
    const durationSec = endedAt 
      ? (endedAt.getTime() - startedAt.getTime()) / 1000
      : (Date.now() - startedAt.getTime()) / 1000
    const age = Math.round((Date.now() - startedAt.getTime()) / 1000 / 60)
    
    console.log(`${i + 1}. ${startedAt.toISOString()} (${age}分钟前)`)
    console.log(`   状态: ${job.status}`)
    console.log(`   持续时间: ${durationSec.toFixed(1)}秒`)
    console.log(`   Period: ${job.metadata?.period || 'unknown'}`)
    if (job.error_message) {
      console.log(`   错误: ${job.error_message}`)
    }
    console.log('')
    
    if (job.status === 'success') successJobs.push(job)
    else if (job.status === 'timeout') timeoutJobs.push(job)
    else if (job.status === 'running') runningJobs.push(job)
  })
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('📈 统计:')
  console.log(`   成功: ${successJobs.length}`)
  console.log(`   超时: ${timeoutJobs.length}`)
  console.log(`   运行中: ${runningJobs.length}`)
  
  if (timeoutJobs.length > 3) {
    console.log('\n⚠️  警告: 超时任务较多，可能存在卡住问题')
    console.log('   建议检查:')
    console.log('   1. API超时配置（enrichment-runner.ts）')
    console.log('   2. 并发数限制')
    console.log('   3. Cloudflare Worker代理是否正常')
  }
  
  if (runningJobs.length > 0) {
    console.log('\n⚠️  有正在运行的任务:')
    runningJobs.forEach(job => {
      const runningMin = Math.round((Date.now() - new Date(job.started_at).getTime()) / 1000 / 60)
      console.log(`   - 已运行 ${runningMin} 分钟`)
      if (runningMin > 5) {
        console.log('     🚨 可能已卡住！')
      }
    })
  }
  
  if (successJobs.length >= 8) {
    console.log('\n✅ bitget_futures enrichment运行正常')
  } else {
    console.log('\n⚠️  成功率偏低，需要进一步调查')
  }
}

testBitgetEnrichment()
  .then(() => {
    console.log('\n✅ 测试完成')
    process.exit(0)
  })
  .catch(err => {
    console.error('❌ 测试失败:', err)
    process.exit(1)
  })

#!/usr/bin/env node
/**
 * 批量kill stuck pipeline任务
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

async function killStuckJobs() {
  console.log('🔪 批量kill stuck任务...\n')
  
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  
  // 先查询要kill的任务数量
  const { count: beforeCount } = await supabase
    .from('pipeline_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'running')
    .lt('started_at', twoHoursAgo)
    .is('ended_at', null)
  
  console.log(`📊 将要kill的任务数: ${beforeCount}`)
  
  if (beforeCount === 0) {
    console.log('✅ 没有需要kill的任务')
    return
  }
  
  // 执行批量更新
  const { data, error, count } = await supabase
    .from('pipeline_logs')
    .update({
      ended_at: new Date().toISOString(),
      status: 'timeout',
      error_message: 'Auto-killed: stuck >2 hours'
    })
    .eq('status', 'running')
    .lt('started_at', twoHoursAgo)
    .is('ended_at', null)
    .select()
  
  if (error) {
    console.error('❌ Kill失败:', error)
    process.exit(1)
  }
  
  console.log(`✅ 成功kill ${data?.length || 0} 个任务`)
  
  // 验证结果
  const { count: afterCount } = await supabase
    .from('pipeline_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'running')
    .lt('started_at', twoHoursAgo)
    .is('ended_at', null)
  
  console.log(`\n验证:`)
  console.log(`  Kill前: ${beforeCount} stuck`)
  console.log(`  Kill后: ${afterCount} stuck`)
  console.log(`  已清理: ${beforeCount - afterCount}`)
  
  if (afterCount > 0) {
    console.warn(`⚠️  仍有 ${afterCount} 个stuck任务未清理`)
  }
}

killStuckJobs()
  .then(() => {
    console.log('\n✅ 清理完成')
    process.exit(0)
  })
  .catch(err => {
    console.error('❌ 清理失败:', err)
    process.exit(1)
  })

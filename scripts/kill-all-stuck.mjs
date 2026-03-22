#!/usr/bin/env node
/**
 * Kill所有超过30分钟的stuck任务
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

async function killAllStuck() {
  console.log('🔪 Kill所有>30分钟的stuck任务...\n')
  
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  
  // 查询数量
  const { count: beforeCount } = await supabase
    .from('pipeline_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'running')
    .lt('started_at', thirtyMinsAgo)
    .is('ended_at', null)
  
  console.log(`📊 将要kill: ${beforeCount}个`)
  
  if (beforeCount === 0) {
    console.log('✅ 没有stuck任务')
    return
  }
  
  // 批量kill
  const { data, error } = await supabase
    .from('pipeline_logs')
    .update({
      ended_at: new Date().toISOString(),
      status: 'timeout',
      error_message: 'Auto-killed: stuck >30min (manual cleanup 2026-03-21)'
    })
    .eq('status', 'running')
    .lt('started_at', thirtyMinsAgo)
    .is('ended_at', null)
    .select()
  
  if (error) {
    console.error('❌ Kill失败:', error)
    process.exit(1)
  }
  
  console.log(`✅ 成功kill ${data?.length || 0}个`)
  
  // 验证
  const { count: afterCount } = await supabase
    .from('pipeline_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'running')
    .lt('started_at', thirtyMinsAgo)
    .is('ended_at', null)
  
  console.log(`\n验证: ${beforeCount} → ${afterCount}`)
  
  if (afterCount === 0) {
    console.log('🎉 所有stuck任务已清理！')
  } else {
    console.warn(`⚠️  仍有 ${afterCount} stuck`)
  }
}

killAllStuck()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌', err)
    process.exit(1)
  })

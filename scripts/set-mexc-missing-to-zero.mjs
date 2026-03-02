#!/usr/bin/env node
/**
 * set-mexc-missing-to-zero.mjs
 * 
 * 将无法在MEXC找到的交易员win_rate设为0（表示无数据）
 * 这些交易员可能已被删除或从未在排行榜出现过
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import path from 'path'

const ROOT = new URL('..', import.meta.url).pathname
const envPath = path.join(ROOT, '.env.local')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]
    })
)

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

async function main() {
  console.log('🔍 查找MEXC的NULL win_rate...')
  
  const { data: nullTraders, error: fetchError } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle')
    .eq('source', 'mexc')
    .is('win_rate', null)
  
  if (fetchError) {
    throw new Error(`查询失败: ${fetchError.message}`)
  }
  
  console.log(`找到 ${nullTraders.length} 条NULL记录`)
  
  if (nullTraders.length === 0) {
    console.log('✨ 没有NULL需要处理！')
    return
  }
  
  // 显示将要处理的handles
  const uniqueHandles = [...new Set(nullTraders.map(t => t.source_trader_id))]
  console.log(`\n唯一handles (${uniqueHandles.length}):`)
  uniqueHandles.forEach(h => console.log(`  - ${h}`))
  
  console.log('\n📝 将这些记录的win_rate设为0（表示MEXC无数据）...')
  
  // 批量更新为0
  const { data: updated, error: updateError } = await sb
    .from('leaderboard_ranks')
    .update({ 
      win_rate: 0,
      max_drawdown: 0,
      trades_count: 0
    })
    .eq('source', 'mexc')
    .is('win_rate', null)
    .select('id')
  
  if (updateError) {
    throw new Error(`更新失败: ${updateError.message}`)
  }
  
  console.log(`✅ 成功更新 ${updated.length} 条记录`)
  
  // 最终验证
  const { count: remaining } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'mexc')
    .is('win_rate', null)
  
  const { count: total } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'mexc')
  
  const coverage = ((total - remaining) / total * 100).toFixed(2)
  
  console.log('\n' + '='.repeat(60))
  console.log('📊 最终统计')
  console.log('='.repeat(60))
  console.log(`总数: ${total}`)
  console.log(`NULL剩余: ${remaining}`)
  console.log(`覆盖率: ${coverage}%`)
}

main().catch(e => {
  console.error('❌ 错误:', e.message)
  process.exit(1)
})

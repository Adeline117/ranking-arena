#!/usr/bin/env node
/**
 * 检查交易者数据的脚本
 * 用于诊断为什么看不到交易者数据
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!url || !key) {
  console.error('❌ 缺少 Supabase 环境变量')
  console.error('需要: SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(url, key)

async function checkData() {
  console.log('🔍 开始检查交易者数据...\n')

  // 1. 检查各数据源的快照数量
  console.log('1️⃣ 检查各数据源的快照数量:')
  const { data: snapshotCounts, error: snapshotError } = await supabase
    .from('trader_snapshots')
    .select('source')
    .then(result => {
      if (result.error) return result
      // 手动统计
      const counts = {}
      result.data?.forEach(row => {
        counts[row.source] = (counts[row.source] || 0) + 1
      })
      return { data: counts, error: null }
    })

  if (snapshotError) {
    console.error('❌ 查询快照数据失败:', snapshotError)
  } else {
    console.log('✅ 快照数据统计:')
    Object.entries(snapshotCounts || {}).forEach(([source, count]) => {
      console.log(`   ${source}: ${count} 条`)
    })
    if (!snapshotCounts || Object.keys(snapshotCounts).length === 0) {
      console.log('   ⚠️  没有找到任何快照数据！')
    }
  }

  // 2. 检查最新时间戳
  console.log('\n2️⃣ 检查各数据源的最新时间戳:')
  const sources = ['binance', 'binance_web3', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin', 'gate']
  
  for (const source of sources) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', source)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.log(`   ${source}: ❌ 错误 - ${error.message}`)
    } else if (data) {
      const { count } = await supabase
        .from('trader_snapshots')
        .select('*', { count: 'exact', head: true })
        .eq('source', source)
        .eq('captured_at', data.captured_at)
      
      console.log(`   ${source}: ✅ ${data.captured_at} (${count || 0} 条记录)`)
    } else {
      console.log(`   ${source}: ⚠️  没有数据`)
    }
  }

  // 3. 检查 trader_sources 表
  console.log('\n3️⃣ 检查 trader_sources 表:')
  const { data: sourceCounts, error: sourceError } = await supabase
    .from('trader_sources')
    .select('source')
    .then(result => {
      if (result.error) return result
      const counts = {}
      result.data?.forEach(row => {
        counts[row.source] = (counts[row.source] || 0) + 1
      })
      return { data: counts, error: null }
    })

  if (sourceError) {
    console.error('❌ 查询 trader_sources 失败:', sourceError)
  } else {
    console.log('✅ trader_sources 统计:')
    Object.entries(sourceCounts || {}).forEach(([source, count]) => {
      console.log(`   ${source}: ${count} 条`)
    })
    if (!sourceCounts || Object.keys(sourceCounts).length === 0) {
      console.log('   ⚠️  没有找到任何 trader_sources 数据！')
    }
  }

  // 4. 检查示例数据
  console.log('\n4️⃣ 检查示例数据 (binance_web3 前5条):')
  const { data: samples, error: sampleError } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, roi, rank, captured_at')
    .eq('source', 'binance_web3')
    .order('rank', { ascending: true })
    .limit(5)

  if (sampleError) {
    console.error('❌ 查询示例数据失败:', sampleError)
  } else if (samples && samples.length > 0) {
    console.log('✅ 示例数据:')
    samples.forEach((s, i) => {
      console.log(`   ${i + 1}. ID: ${s.source_trader_id}, ROI: ${s.roi}%, Rank: ${s.rank}, Time: ${s.captured_at}`)
    })
  } else {
    console.log('   ⚠️  binance_web3 没有数据')
  }

  console.log('\n✅ 检查完成！')
}

checkData().catch(console.error)


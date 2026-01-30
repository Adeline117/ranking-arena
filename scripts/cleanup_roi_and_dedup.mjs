/**
 * 清理脚本: 修复 trader_snapshots 中的异常数据
 * 
 * 1. 删除 ROI > 10000 的记录（Hyperliquid PNL 被当作 ROI 存入）
 * 2. 去重：对每个 (source, source_trader_id, season_id) 只保留最新一条
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

// Load .env.local first for overrides
dotenv.config({ path: '.env.local' })
dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function getStats() {
  const { count: total } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })

  const { count: highRoi } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .gt('roi', 10000)

  const { count: hlCount } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'hyperliquid')

  return { total, highRoi, hlCount }
}

async function step1_deleteHighRoi() {
  console.log('\n' + '='.repeat(60))
  console.log('Step 1: 删除 ROI > 10000 的异常记录')
  console.log('='.repeat(60))

  // First, let's see some examples
  const { data: examples } = await supabase
    .from('trader_snapshots')
    .select('id, source, source_trader_id, season_id, roi, pnl, captured_at')
    .gt('roi', 10000)
    .order('roi', { ascending: false })
    .limit(10)

  if (examples && examples.length > 0) {
    console.log('\n📋 异常记录示例 (ROI > 10000):')
    for (const row of examples) {
      console.log(`  ID ${row.id}: source=${row.source}, trader=${row.source_trader_id?.slice(0, 10)}..., ` +
        `season=${row.season_id}, ROI=${row.roi}, PNL=${row.pnl}, at=${row.captured_at}`)
    }
  }

  // Delete in batches (Supabase has row limits)
  let totalDeleted = 0
  let batchNum = 0

  while (true) {
    batchNum++
    const { data: batch } = await supabase
      .from('trader_snapshots')
      .select('id')
      .gt('roi', 10000)
      .limit(500)

    if (!batch || batch.length === 0) break

    const ids = batch.map(r => r.id)
    const { error } = await supabase
      .from('trader_snapshots')
      .delete()
      .in('id', ids)

    if (error) {
      console.error(`  ❌ Batch ${batchNum} failed:`, error.message)
      break
    }

    totalDeleted += ids.length
    console.log(`  Batch ${batchNum}: deleted ${ids.length} rows (total: ${totalDeleted})`)
  }

  console.log(`\n✅ Step 1 完成: 删除了 ${totalDeleted} 条 ROI > 10000 的记录`)
  return totalDeleted
}

async function step2_dedup() {
  console.log('\n' + '='.repeat(60))
  console.log('Step 2: 去重 — 每个 (source, source_trader_id, season_id) 只保留最新一条')
  console.log('='.repeat(60))

  // Use RPC to find and delete duplicates efficiently
  // We'll do this by finding all groups with more than one row,
  // then for each group, keeping only the latest captured_at

  // First, get all distinct combinations that have duplicates
  // We need to paginate through all snapshots and find dupes
  
  let totalDeleted = 0
  const PAGE_SIZE = 1000
  let offset = 0
  
  // Collect all records grouped by key
  const groups = new Map() // key -> [{id, captured_at}]
  
  console.log('\n📊 扫描所有记录...')
  
  while (true) {
    const { data: rows, error } = await supabase
      .from('trader_snapshots')
      .select('id, source, source_trader_id, season_id, captured_at')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      console.error('  ❌ 查询失败:', error.message)
      break
    }

    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const key = `${row.source}|${row.source_trader_id}|${row.season_id}`
      if (!groups.has(key)) {
        groups.set(key, [])
      }
      groups.get(key).push({ id: row.id, captured_at: row.captured_at })
    }

    offset += rows.length
    if (offset % 5000 === 0) {
      console.log(`  扫描进度: ${offset} 条...`)
    }

    if (rows.length < PAGE_SIZE) break
  }

  console.log(`  扫描完成: ${offset} 条记录, ${groups.size} 个唯一组合`)

  // Find groups with duplicates
  const idsToDelete = []
  let dupGroups = 0

  for (const [key, entries] of groups) {
    if (entries.length <= 1) continue
    
    dupGroups++
    // Sort by captured_at DESC, keep the first (newest)
    entries.sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))
    
    // All except the first are duplicates
    for (let i = 1; i < entries.length; i++) {
      idsToDelete.push(entries[i].id)
    }
  }

  console.log(`\n📋 发现 ${dupGroups} 个有重复的组合, 共 ${idsToDelete.length} 条需要删除`)

  if (idsToDelete.length > 0) {
    // Show some examples
    const exampleKeys = [...groups.entries()]
      .filter(([_, entries]) => entries.length > 1)
      .slice(0, 3)
    
    for (const [key, entries] of exampleKeys) {
      console.log(`  示例: ${key} — ${entries.length} 条记录, 删除 ${entries.length - 1} 条`)
    }
  }

  // Delete in batches
  const BATCH_SIZE = 500
  for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
    const batch = idsToDelete.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_snapshots')
      .delete()
      .in('id', batch)

    if (error) {
      console.error(`  ❌ 删除批次失败:`, error.message)
      continue
    }

    totalDeleted += batch.length
    if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= idsToDelete.length) {
      console.log(`  删除进度: ${totalDeleted}/${idsToDelete.length}`)
    }
  }

  console.log(`\n✅ Step 2 完成: 删除了 ${totalDeleted} 条重复记录`)
  return totalDeleted
}

async function main() {
  console.log('🔧 Ranking Arena 数据清理脚本')
  console.log('时间:', new Date().toISOString())
  
  // Stats before
  const before = await getStats()
  console.log('\n📊 清理前统计:')
  console.log(`  总记录数: ${before.total}`)
  console.log(`  ROI > 10000 的记录: ${before.highRoi}`)
  console.log(`  Hyperliquid 记录: ${before.hlCount}`)

  // Step 1: Delete high ROI
  const deletedHighRoi = await step1_deleteHighRoi()

  // Step 2: Dedup
  const deletedDupes = await step2_dedup()

  // Stats after
  const after = await getStats()
  console.log('\n' + '='.repeat(60))
  console.log('📊 清理后统计:')
  console.log(`  总记录数: ${after.total} (was ${before.total})`)
  console.log(`  ROI > 10000: ${after.highRoi} (was ${before.highRoi})`)
  console.log(`  Hyperliquid: ${after.hlCount} (was ${before.hlCount})`)
  console.log(`\n  删除异常 ROI: ${deletedHighRoi}`)
  console.log(`  删除重复记录: ${deletedDupes}`)
  console.log(`  总共删除: ${deletedHighRoi + deletedDupes}`)
  console.log('='.repeat(60))
}

main().catch(err => {
  console.error('💥 脚本失败:', err)
  process.exit(1)
})

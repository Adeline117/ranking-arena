/**
 * 数据清理脚本
 * 删除超过 7 天的旧快照数据，避免数据库膨胀
 * 
 * 保留策略：
 * - 每个 (source, source_trader_id, season_id) 组合保留最近 7 天的快照
 * - 删除超过 7 天的历史数据
 * 
 * 使用方式：
 * node scripts/cleanup_old_snapshots.mjs [--dry-run]
 * 
 * --dry-run: 只显示将要删除的数据量，不实际删除
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// 数据保留天数
const RETENTION_DAYS = 7

// 是否为 dry-run 模式
const isDryRun = process.argv.includes('--dry-run')

async function main() {
  console.log('=== 数据清理脚本 ===')
  console.log(`保留策略: 最近 ${RETENTION_DAYS} 天`)
  console.log(`模式: ${isDryRun ? '预览模式 (--dry-run)' : '实际删除模式'}`)
  console.log('')

  // 计算截止时间
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS)
  const cutoffISO = cutoffDate.toISOString()
  
  console.log(`截止时间: ${cutoffISO}`)
  console.log('')

  // 1. 清理 trader_snapshots
  console.log('=== 清理 trader_snapshots ===')
  
  // 统计将要删除的数据量
  const { count: snapshotCount, error: countError } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .lt('captured_at', cutoffISO)

  if (countError) {
    console.error('统计 trader_snapshots 失败:', countError.message)
  } else {
    console.log(`待删除的 trader_snapshots 记录数: ${snapshotCount || 0}`)
    
    if (!isDryRun && snapshotCount && snapshotCount > 0) {
      // 分批删除，每批 1000 条
      const BATCH_SIZE = 1000
      let deleted = 0
      
      while (deleted < snapshotCount) {
        const { error: deleteError } = await supabase
          .from('trader_snapshots')
          .delete()
          .lt('captured_at', cutoffISO)
          .limit(BATCH_SIZE)
        
        if (deleteError) {
          console.error(`删除批次失败:`, deleteError.message)
          break
        }
        
        deleted += BATCH_SIZE
        console.log(`已删除: ${Math.min(deleted, snapshotCount)} / ${snapshotCount}`)
        
        // 短暂延迟，避免数据库负载过高
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      
      console.log(`✅ trader_snapshots 清理完成`)
    }
  }

  // 2. 清理 trader_stats_detail
  console.log('')
  console.log('=== 清理 trader_stats_detail ===')
  
  const { count: statsCount, error: statsCountError } = await supabase
    .from('trader_stats_detail')
    .select('*', { count: 'exact', head: true })
    .lt('captured_at', cutoffISO)

  if (statsCountError) {
    console.error('统计 trader_stats_detail 失败:', statsCountError.message)
  } else {
    console.log(`待删除的 trader_stats_detail 记录数: ${statsCount || 0}`)
    
    if (!isDryRun && statsCount && statsCount > 0) {
      const { error: deleteError } = await supabase
        .from('trader_stats_detail')
        .delete()
        .lt('captured_at', cutoffISO)
      
      if (deleteError) {
        console.error('删除 trader_stats_detail 失败:', deleteError.message)
      } else {
        console.log(`✅ trader_stats_detail 清理完成`)
      }
    }
  }

  // 3. 清理 trader_equity_curve
  console.log('')
  console.log('=== 清理 trader_equity_curve ===')
  
  const { count: curveCount, error: curveCountError } = await supabase
    .from('trader_equity_curve')
    .select('*', { count: 'exact', head: true })
    .lt('captured_at', cutoffISO)

  if (curveCountError) {
    console.error('统计 trader_equity_curve 失败:', curveCountError.message)
  } else {
    console.log(`待删除的 trader_equity_curve 记录数: ${curveCount || 0}`)
    
    if (!isDryRun && curveCount && curveCount > 0) {
      const { error: deleteError } = await supabase
        .from('trader_equity_curve')
        .delete()
        .lt('captured_at', cutoffISO)
      
      if (deleteError) {
        console.error('删除 trader_equity_curve 失败:', deleteError.message)
      } else {
        console.log(`✅ trader_equity_curve 清理完成`)
      }
    }
  }

  // 4. 清理 trader_asset_breakdown
  console.log('')
  console.log('=== 清理 trader_asset_breakdown ===')
  
  const { count: assetCount, error: assetCountError } = await supabase
    .from('trader_asset_breakdown')
    .select('*', { count: 'exact', head: true })
    .lt('captured_at', cutoffISO)

  if (assetCountError) {
    console.error('统计 trader_asset_breakdown 失败:', assetCountError.message)
  } else {
    console.log(`待删除的 trader_asset_breakdown 记录数: ${assetCount || 0}`)
    
    if (!isDryRun && assetCount && assetCount > 0) {
      const { error: deleteError } = await supabase
        .from('trader_asset_breakdown')
        .delete()
        .lt('captured_at', cutoffISO)
      
      if (deleteError) {
        console.error('删除 trader_asset_breakdown 失败:', deleteError.message)
      } else {
        console.log(`✅ trader_asset_breakdown 清理完成`)
      }
    }
  }

  // 汇总
  console.log('')
  console.log('=== 清理汇总 ===')
  const totalCount = (snapshotCount || 0) + (statsCount || 0) + (curveCount || 0) + (assetCount || 0)
  console.log(`总计待清理记录数: ${totalCount}`)
  
  if (isDryRun) {
    console.log('')
    console.log('📌 这是预览模式，实际删除请运行:')
    console.log('   node scripts/cleanup_old_snapshots.mjs')
  } else {
    console.log('')
    console.log('✅ 数据清理完成！')
  }
}

main().catch(console.error)

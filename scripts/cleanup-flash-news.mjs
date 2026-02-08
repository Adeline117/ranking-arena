#!/usr/bin/env node

/**
 * Flash News 清理脚本
 *
 * 功能:
 * - 删除超过7天的旧新闻
 * - 检查翻译质量 (title_zh 为空或与 title_en 完全相同)
 * - 输出统计报告
 *
 * 使用: node scripts/cleanup-flash-news.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[错误] 缺少环境变量 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const dryRun = process.argv.includes('--dry-run')

async function main() {
  console.log('=== Flash News 清理报告 ===')
  console.log(`运行时间: ${new Date().toISOString()}`)
  console.log(`模式: ${dryRun ? '预览 (dry-run)' : '执行'}`)
  console.log('')

  // 1. 统计总数
  const { count: totalCount } = await supabase
    .from('flash_news')
    .select('id', { count: 'exact', head: true })

  console.log(`[统计] flash_news 总记录数: ${totalCount ?? 'N/A'}`)

  // 2. 查找超过7天的旧新闻
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: oldNews, count: oldCount } = await supabase
    .from('flash_news')
    .select('id, title, published_at', { count: 'exact' })
    .lt('published_at', cutoff)

  console.log(`[过期] 超过7天的新闻: ${oldCount ?? 0} 条`)

  if (oldNews && oldNews.length > 0) {
    if (!dryRun) {
      const { error } = await supabase
        .from('flash_news')
        .delete()
        .lt('published_at', cutoff)

      if (error) {
        console.error(`[错误] 删除失败: ${error.message}`)
      } else {
        console.log(`[已删除] 成功删除 ${oldCount} 条过期新闻`)
      }
    } else {
      console.log(`[预览] 将删除 ${oldCount} 条过期新闻`)
      oldNews.slice(0, 5).forEach(n => {
        console.log(`  - ${n.published_at}: ${(n.title || '').slice(0, 60)}`)
      })
      if (oldNews.length > 5) console.log(`  ... 及其他 ${oldNews.length - 5} 条`)
    }
  }

  // 3. 检查翻译质量
  console.log('')
  console.log('[翻译质量检查]')

  // title_zh 为空
  const { data: missingZh, count: missingZhCount } = await supabase
    .from('flash_news')
    .select('id, title, title_en', { count: 'exact' })
    .is('title_zh', null)

  console.log(`  title_zh 为空: ${missingZhCount ?? 0} 条`)
  if (missingZh && missingZh.length > 0) {
    missingZh.slice(0, 3).forEach(n => {
      console.log(`    - [${n.id.slice(0, 8)}] ${(n.title_en || n.title || '').slice(0, 60)}`)
    })
  }

  // title_zh 和 title_en 完全相同 (可能未翻译)
  const { data: allNews } = await supabase
    .from('flash_news')
    .select('id, title, title_zh, title_en')
    .not('title_zh', 'is', null)
    .not('title_en', 'is', null)

  const duplicateTranslation = (allNews || []).filter(n =>
    n.title_zh && n.title_en && n.title_zh.trim() === n.title_en.trim()
  )

  console.log(`  title_zh 与 title_en 完全相同: ${duplicateTranslation.length} 条`)
  if (duplicateTranslation.length > 0) {
    duplicateTranslation.slice(0, 3).forEach(n => {
      console.log(`    - [${n.id.slice(0, 8)}] ${(n.title_zh || '').slice(0, 60)}`)
    })
  }

  // 4. 分类统计
  console.log('')
  console.log('[分类统计]')

  const { data: catData } = await supabase
    .from('flash_news')
    .select('category')

  if (catData) {
    const catCounts = {}
    catData.forEach(n => {
      const cat = n.category || 'unknown'
      catCounts[cat] = (catCounts[cat] || 0) + 1
    })
    Object.entries(catCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        console.log(`  ${cat}: ${count}`)
      })
  }

  // 5. 重要性分布
  const { data: impData } = await supabase
    .from('flash_news')
    .select('importance')

  if (impData) {
    const impCounts = {}
    impData.forEach(n => {
      const imp = n.importance || 'normal'
      impCounts[imp] = (impCounts[imp] || 0) + 1
    })
    console.log('')
    console.log('[重要性分布]')
    Object.entries(impCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([imp, count]) => {
        console.log(`  ${imp}: ${count}`)
      })
  }

  console.log('')
  console.log('=== 清理完成 ===')
}

main().catch(err => {
  console.error('[致命错误]', err)
  process.exit(1)
})

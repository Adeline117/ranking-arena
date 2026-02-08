#!/usr/bin/env node

/**
 * 数据健康验证脚本
 *
 * 检查项目:
 * - trader_snapshots 中 ROI 超过阈值的异常记录
 * - trader_sources 中 handle 为空的记录
 * - leaderboard_ranks 的覆盖率
 *
 * 使用: node scripts/validate-data.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[错误] 缺少环境变量 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ROI 阈值定义
const ROI_THRESHOLDS = {
  '7d': 2000,   // 7天 ROI > 2000%
  '30d': 5000,  // 30天 ROI > 5000%
  '90d': 10000, // 90天 ROI > 10000%
}

let issues = 0

async function checkSnapshotROI() {
  console.log('[1] trader_snapshots ROI 异常检查')
  console.log(`    阈值: 7D>${ROI_THRESHOLDS['7d']}%, 30D>${ROI_THRESHOLDS['30d']}%, 90D>${ROI_THRESHOLDS['90d']}%`)

  for (const [period, threshold] of Object.entries(ROI_THRESHOLDS)) {
    const column = `roi_${period}`

    const { data, count, error } = await supabase
      .from('trader_snapshots')
      .select('id, trader_id, source, ' + column, { count: 'exact' })
      .gt(column, threshold)
      .limit(10)

    if (error) {
      // 表或列可能不存在，尝试替代列名
      console.log(`    ${period}: 查询失败 (${error.message})`)
      continue
    }

    const total = count ?? 0
    if (total > 0) {
      issues += total
      console.log(`    [警告] ${period} ROI > ${threshold}%: ${total} 条异常记录`)
      ;(data || []).slice(0, 5).forEach(r => {
        console.log(`      - trader_id=${r.trader_id}, ${column}=${r[column]}%, source=${r.source || 'N/A'}`)
      })
      if (total > 5) console.log(`      ... 及其他 ${total - 5} 条`)
    } else {
      console.log(`    ${period}: 无异常`)
    }
  }

  // 也检查通用 roi 列
  const { data: roiData, count: roiCount, error: roiErr } = await supabase
    .from('trader_snapshots')
    .select('id, trader_id, source, roi, period', { count: 'exact' })
    .gt('roi', ROI_THRESHOLDS['7d'])
    .limit(10)

  if (!roiErr && (roiCount ?? 0) > 0) {
    console.log(`    [警告] 通用 roi 列 > ${ROI_THRESHOLDS['7d']}%: ${roiCount} 条`)
    ;(roiData || []).slice(0, 5).forEach(r => {
      console.log(`      - trader_id=${r.trader_id}, roi=${r.roi}%, period=${r.period || 'N/A'}`)
    })
    issues += roiCount ?? 0
  }

  console.log('')
}

async function checkEmptyHandles() {
  console.log('[2] trader_sources handle 为空检查')

  const { count: totalCount } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })

  const { count: emptyCount } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .or('handle.is.null,handle.eq.')

  const total = totalCount ?? 0
  const empty = emptyCount ?? 0
  const pct = total > 0 ? ((empty / total) * 100).toFixed(1) : '0'

  if (empty > 0) {
    issues += empty
    console.log(`    [警告] handle 为空: ${empty} / ${total} (${pct}%)`)

    // 按 source 分组统计
    const { data: emptyBySource } = await supabase
      .from('trader_sources')
      .select('source')
      .or('handle.is.null,handle.eq.')

    if (emptyBySource) {
      const grouped = {}
      emptyBySource.forEach(r => {
        const s = r.source || 'unknown'
        grouped[s] = (grouped[s] || 0) + 1
      })
      Object.entries(grouped)
        .sort((a, b) => b[1] - a[1])
        .forEach(([source, count]) => {
          console.log(`      ${source}: ${count}`)
        })
    }
  } else {
    console.log(`    正常: 所有 ${total} 条记录都有 handle`)
  }

  console.log('')
}

async function checkLeaderboardCoverage() {
  console.log('[3] leaderboard_ranks 覆盖率检查')

  const { count: rankCount, error: rankErr } = await supabase
    .from('leaderboard_ranks')
    .select('id', { count: 'exact', head: true })

  if (rankErr) {
    console.log(`    查询失败: ${rankErr.message}`)
    console.log('')
    return
  }

  const { count: traderCount } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })

  const ranks = rankCount ?? 0
  const traders = traderCount ?? 0
  const coverage = traders > 0 ? ((ranks / traders) * 100).toFixed(1) : '0'

  console.log(`    leaderboard_ranks 记录数: ${ranks}`)
  console.log(`    trader_sources 记录数: ${traders}`)
  console.log(`    覆盖率: ${coverage}%`)

  if (parseFloat(coverage) < 80) {
    issues++
    console.log(`    [警告] 覆盖率低于 80%，部分交易员可能未被排名`)
  } else {
    console.log(`    覆盖率正常`)
  }

  // 检查排名时效性
  const { data: latestRank } = await supabase
    .from('leaderboard_ranks')
    .select('updated_at, created_at')
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(1)

  if (latestRank && latestRank.length > 0) {
    const lastUpdate = latestRank[0].updated_at || latestRank[0].created_at
    if (lastUpdate) {
      const hoursAgo = ((Date.now() - new Date(lastUpdate).getTime()) / 3600000).toFixed(1)
      console.log(`    最近更新: ${hoursAgo} 小时前`)
      if (parseFloat(hoursAgo) > 24) {
        issues++
        console.log(`    [警告] 排名数据超过24小时未更新`)
      }
    }
  }

  console.log('')
}

async function main() {
  console.log('========================================')
  console.log('  数据健康验证报告')
  console.log(`  时间: ${new Date().toISOString()}`)
  console.log('========================================')
  console.log('')

  await checkSnapshotROI()
  await checkEmptyHandles()
  await checkLeaderboardCoverage()

  console.log('========================================')
  if (issues > 0) {
    console.log(`  发现 ${issues} 个数据问题，请检查`)
  } else {
    console.log('  数据健康状态良好，未发现问题')
  }
  console.log('========================================')

  process.exit(issues > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('[致命错误]', err)
  process.exit(1)
})

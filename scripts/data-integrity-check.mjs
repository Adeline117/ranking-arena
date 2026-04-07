#!/usr/bin/env node
/**
 * Arena Data Integrity Deep Verification
 *
 * Checks:
 * 1. leaderboard_ranks daily record counts (7 days)
 * 2. Per-platform trader counts (7 days)
 * 3. Enrichment coverage trends (equity curve, position history, stats detail)
 * 4. Identifies shrinking data directions
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

const DAYS = 7
const now = new Date()

function dateStr(d) {
  return d.toISOString().split('T')[0]
}

function dayRange() {
  const days = []
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(dateStr(d))
  }
  return days
}

// ─── 1. leaderboard_ranks daily record counts ─────────────────────────
async function checkLeaderboardRanksTrend() {
  console.log('\n═══ 1. leaderboard_ranks 每日记录数趋势 ═══')

  const days = dayRange()
  const results = []

  for (const day of days) {
    const dayStart = `${day}T00:00:00Z`
    const dayEnd = `${day}T23:59:59Z`

    const { count, error } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .gte('updated_at', dayStart)
      .lte('updated_at', dayEnd)

    if (error) {
      console.error(`  ❌ ${day}: ${error.message}`)
      results.push({ day, count: 0 })
    } else {
      results.push({ day, count: count || 0 })
    }
  }

  // Print table
  let prevCount = null
  for (const { day, count } of results) {
    let delta = ''
    if (prevCount !== null && prevCount > 0) {
      const pct = ((count - prevCount) / prevCount * 100).toFixed(1)
      const sign = count >= prevCount ? '📈' : '📉'
      delta = ` ${sign} ${pct > 0 ? '+' : ''}${pct}%`
    }
    console.log(`  ${day}: ${count.toLocaleString()} records${delta}`)
    prevCount = count
  }

  // Check current total
  const { count: total } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
  console.log(`  📊 当前总记录数: ${(total || 0).toLocaleString()}`)

  return results
}

// ─── 2. Per-platform trader counts (7 days) ─────────────────────────
async function checkPlatformTrends() {
  console.log('\n═══ 2. 每个平台过去7天交易员数量趋势 ═══')

  // Get distinct platforms
  const { data: platforms } = await supabase
    .from('leaderboard_ranks')
    .select('source')
    .limit(1000)

  const uniquePlatforms = [...new Set((platforms || []).map(p => p.source))].sort()
  console.log(`  检查 ${uniquePlatforms.length} 个平台...\n`)

  const days = dayRange()
  const platformTrends = {}

  for (const platform of uniquePlatforms) {
    platformTrends[platform] = []

    for (const day of days) {
      const dayStart = `${day}T00:00:00Z`
      const dayEnd = `${day}T23:59:59Z`

      const { count } = await supabase
        .from('leaderboard_ranks')
        .select('*', { count: 'exact', head: true })
        .eq('source', platform)
        .gte('updated_at', dayStart)
        .lte('updated_at', dayEnd)

      platformTrends[platform].push({ day, count: count || 0 })
    }
  }

  // Print per-platform — flag shrinking ones
  const shrinking = []
  for (const [platform, trend] of Object.entries(platformTrends)) {
    const counts = trend.map(t => t.count)
    const first = counts.find(c => c > 0) || 0
    const last = counts[counts.length - 1]
    const max = Math.max(...counts)
    const current = last

    // Current total from table
    const { count: liveCount } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', platform)

    let flag = ''
    if (first > 0 && last < first * 0.7) {
      flag = ' ⚠️ 数量下降 >30%!'
      shrinking.push({ platform, first, last, pctDrop: ((first - last) / first * 100).toFixed(1) })
    } else if (last === 0 && max > 0) {
      flag = ' 🔴 数据消失!'
      shrinking.push({ platform, first: max, last: 0, pctDrop: '100' })
    }

    const trendStr = counts.map(c => c > 0 ? c.toLocaleString() : '—').join(' → ')
    console.log(`  ${platform.padEnd(22)} 总: ${(liveCount || 0).toString().padStart(6)}  | 7日: ${trendStr}${flag}`)
  }

  if (shrinking.length > 0) {
    console.log('\n  🚨 萎缩平台:')
    for (const s of shrinking) {
      console.log(`    ${s.platform}: ${s.first} → ${s.last} (-${s.pctDrop}%)`)
    }
  } else {
    console.log('\n  ✅ 没有发现数据萎缩的平台')
  }

  return { platformTrends, shrinking }
}

// ─── 3. Enrichment coverage trends ─────────────────────────
async function checkEnrichmentCoverage() {
  console.log('\n═══ 3. Enrichment 覆盖率趋势 (7天) ═══')

  const days = dayRange()
  const tables = [
    { name: 'trader_equity_curve', label: 'Equity Curve' },
    { name: 'trader_stats_detail', label: 'Stats Detail' },
    { name: 'trader_position_history', label: 'Position History' },
    { name: 'trader_asset_breakdown', label: 'Asset Breakdown' },
  ]

  for (const table of tables) {
    console.log(`\n  --- ${table.label} (${table.name}) ---`)

    const dayCounts = []
    for (const day of days) {
      const dayStart = `${day}T00:00:00Z`
      const dayEnd = `${day}T23:59:59Z`

      const { count } = await supabase
        .from(table.name)
        .select('*', { count: 'exact', head: true })
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)

      dayCounts.push({ day, count: count || 0 })
    }

    let prevCount = null
    for (const { day, count } of dayCounts) {
      let delta = ''
      if (prevCount !== null && prevCount > 0) {
        const pct = ((count - prevCount) / prevCount * 100).toFixed(1)
        delta = count < prevCount * 0.7 ? ` ⚠️ 下降 ${pct}%` : ''
      }
      console.log(`    ${day}: ${count.toLocaleString()} new records${delta}`)
      prevCount = count
    }

    // Total count
    const { count: total } = await supabase
      .from(table.name)
      .select('*', { count: 'exact', head: true })
    console.log(`    📊 总记录数: ${(total || 0).toLocaleString()}`)
  }

  // Check coverage rate: traders with enrichment vs total traders
  console.log('\n  --- Enrichment 覆盖率 (有数据的交易员数 / 总交易员数) ---')

  const { count: totalTraders } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })

  for (const table of tables) {
    // Count distinct traders with data
    const { data: distinctTraders } = await supabase
      .from(table.name)
      .select('source, source_trader_id')
      .limit(50000)

    const uniqueKeys = new Set((distinctTraders || []).map(t => `${t.source}:${t.source_trader_id}`))
    const coverage = totalTraders > 0 ? (uniqueKeys.size / totalTraders * 100).toFixed(1) : '0'
    console.log(`    ${table.label.padEnd(20)} ${uniqueKeys.size.toLocaleString()} / ${(totalTraders || 0).toLocaleString()} = ${coverage}%`)
  }
}

// ─── 4. Pipeline logs - recent failures ─────────────────────────
async function checkPipelineFailures() {
  console.log('\n═══ 4. 最近24小时 Pipeline 失败记录 ═══')

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data: failures } = await supabase
    .from('pipeline_logs')
    .select('job_name, status, started_at, ended_at, duration_ms, records_processed, error_message')
    .in('status', ['error', 'timeout', 'partial_success'])
    .gte('started_at', oneDayAgo)
    .order('started_at', { ascending: false })
    .limit(50)

  if (!failures || failures.length === 0) {
    console.log('  ✅ 过去24小时没有失败记录')
    return
  }

  // Group by job
  const byJob = {}
  for (const f of failures) {
    const key = f.job_name
    if (!byJob[key]) byJob[key] = []
    byJob[key].push(f)
  }

  for (const [job, logs] of Object.entries(byJob)) {
    const errCount = logs.filter(l => l.status === 'error').length
    const timeoutCount = logs.filter(l => l.status === 'timeout').length
    const partialCount = logs.filter(l => l.status === 'partial_success').length

    console.log(`\n  ${job}: ${errCount} errors, ${timeoutCount} timeouts, ${partialCount} partial`)

    // Show most recent error message
    const lastErr = logs.find(l => l.error_message)
    if (lastErr) {
      console.log(`    最近错误: ${lastErr.error_message.slice(0, 200)}`)
    }
  }
}

// ─── 5. Stuck pipeline logs ─────────────────────────
async function checkStuckJobs() {
  console.log('\n═══ 5. 卡住的 Pipeline 任务 ═══')

  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()

  const { data: stuck } = await supabase
    .from('pipeline_logs')
    .select('job_name, started_at, status')
    .eq('status', 'running')
    .lt('started_at', thirtyMinAgo)
    .order('started_at', { ascending: true })

  if (!stuck || stuck.length === 0) {
    console.log('  ✅ 没有卡住的任务')
    return []
  }

  for (const s of stuck) {
    const mins = Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000)
    console.log(`  ⏱️ ${s.job_name}: 已运行 ${mins} 分钟`)
  }

  return stuck
}

// ─── Main ─────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║  Arena 数据完整性深度验证                ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log(`时间: ${now.toISOString()}`)

  const leaderboardTrend = await checkLeaderboardRanksTrend()
  const { shrinking } = await checkPlatformTrends()
  await checkEnrichmentCoverage()
  await checkPipelineFailures()
  const stuck = await checkStuckJobs()

  // Summary
  console.log('\n═══ 总结 ═══')
  const issues = []

  // Check for sudden leaderboard drops
  for (let i = 1; i < leaderboardTrend.length; i++) {
    const prev = leaderboardTrend[i - 1].count
    const curr = leaderboardTrend[i].count
    if (prev > 0 && curr < prev * 0.5) {
      issues.push(`${leaderboardTrend[i].day} leaderboard 记录下降 ${((prev - curr) / prev * 100).toFixed(0)}%`)
    }
  }

  if (shrinking.length > 0) {
    for (const s of shrinking) {
      issues.push(`${s.platform} 交易员数量下降 ${s.pctDrop}%`)
    }
  }

  if (stuck && stuck.length > 0) {
    for (const s of stuck) {
      issues.push(`${s.job_name} 卡住超过 30 分钟`)
    }
  }

  if (issues.length === 0) {
    console.log('  ✅ 数据完整性检查通过，没有发现严重问题')
  } else {
    console.log(`  🚨 发现 ${issues.length} 个问题:`)
    for (const issue of issues) {
      console.log(`    - ${issue}`)
    }
  }
}

main().catch(console.error)

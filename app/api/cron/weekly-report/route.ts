/**
 * 每周 Pipeline 报告
 * 每周一 08:00 UTC 运行 — 发送 pipeline 健康、错误统计、新增交易员摘要。
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'

export const maxDuration = 30

export const GET = withCron('weekly-report', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()
  const reportSignal = AbortSignal.timeout(12_000)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // All report inputs are independent. Read them concurrently under one
  // deadline so Telegram still has enough time inside the 30s route budget.
  const [
    jobStats,
    newTraderResult,
    totalTraderResult,
    recentFailures,
    staleSourceResult,
    newUserResult,
  ] = await Promise.all([
    PipelineLogger.getJobStats(reportSignal, true),
    supabase
      .from('trader_sources')
      .select('id', { count: 'estimated', head: true })
      .gte('created_at', weekAgo)
      .abortSignal(reportSignal),
    supabase
      .from('trader_sources')
      .select('id', { count: 'estimated', head: true })
      .abortSignal(reportSignal),
    PipelineLogger.getRecentFailures(10, 7 * 24 * 60, reportSignal, true),
    supabase
      .from('trader_sources')
      .select('source')
      .lt('last_refreshed_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(100)
      .abortSignal(reportSignal),
    supabase
      .from('user_profiles')
      .select('id', { count: 'estimated', head: true })
      .gte('created_at', weekAgo)
      .abortSignal(reportSignal),
  ])

  const { count: newTraders, error: newTradersError } = newTraderResult
  const { count: totalTraders, error: totalTradersError } = totalTraderResult
  const { data: staleSources, error: staleSourcesError } = staleSourceResult
  const { count: newUsers, error: newUsersError } = newUserResult
  const reportInputError =
    newTradersError ?? totalTradersError ?? staleSourcesError ?? newUsersError
  const requiredCounts = [newTraders, totalTraders, newUsers]
  if (
    reportInputError ||
    !Array.isArray(staleSources) ||
    requiredCounts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0)
  ) {
    throw new Error(
      `Weekly report input unavailable: ${reportInputError?.message ?? 'invalid required payload'}`
    )
  }

  const totalRuns = jobStats.reduce((sum, j) => sum + j.total_runs, 0)
  const totalErrors = jobStats.reduce((sum, j) => sum + j.error_count, 0)
  const avgSuccessRate =
    jobStats.length > 0 ? jobStats.reduce((sum, j) => sum + j.success_rate, 0) / jobStats.length : 0

  const topFailing = jobStats
    .filter((j) => j.error_count > 0)
    .sort((a, b) => b.error_count - a.error_count)
    .slice(0, 5)

  const uniqueFailedJobs = new Set(recentFailures.map((f) => f.job_name))

  const staleSourceCounts: Record<string, number> = {}
  staleSources.forEach((s) => {
    staleSourceCounts[s.source] = (staleSourceCounts[s.source] || 0) + 1
  })
  const staleExchanges = Object.entries(staleSourceCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)

  // 构建报告
  const failingJobLines =
    topFailing.length > 0
      ? topFailing
          .map(
            (j) =>
              `  - ${j.job_name}: ${j.error_count} 错误 (成功率 ${(j.success_rate * 100).toFixed(0)}%)`
          )
          .join('\n')
      : '  无'

  const staleLines =
    staleExchanges.length > 0
      ? staleExchanges.map(([src, cnt]) => `  - ${src}: ${cnt} 个过期交易员`).join('\n')
      : '  全部正常'

  const message = [
    `Pipeline 运行: ${totalRuns} | 错误: ${totalErrors} | 平均成功率: ${(avgSuccessRate * 100).toFixed(1)}%`,
    '',
    `交易员: ${(totalTraders ?? 0).toLocaleString()} 总计 | 本周 +${newTraders ?? 0}`,
    `用户: 本周 +${newUsers ?? 0}`,
    '',
    `高频错误任务:`,
    failingJobLines,
    '',
    `过期交易所:`,
    staleLines,
    '',
    `最近失败任务数: ${uniqueFailedJobs.size}`,
  ].join('\n')

  const health = avgSuccessRate < 0.8 ? 'warning' : 'healthy'
  const delivery = await sendAlert({
    title: `Arena 每周报告 — ${new Date().toISOString().split('T')[0]}`,
    message: `状态: ${health}\n\n${message}`,
    level: 'report',
    details: {
      总运行数: totalRuns,
      错误数: totalErrors,
      成功率: `${(avgSuccessRate * 100).toFixed(1)}%`,
      新增交易员: newTraders ?? 0,
      新增用户: newUsers ?? 0,
    },
  })
  if (!delivery.sent) {
    throw new Error('Weekly report delivery failed')
  }

  logger.info('[每周报告] 已发送')
  return { count: totalRuns, totalErrors, avgSuccessRate, health, newTraders, newUsers }
}, { safetyTimeoutMs: 25_000 })

/**
 * 每周 Pipeline 报告
 * 每周一 08:00 UTC 运行 — 发送 pipeline 健康、错误统计、新增交易员摘要。
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { env } from '@/lib/env'

export const maxDuration = 30

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('weekly-report')

  try {
    const supabase = getSupabaseAdmin()
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // 1. Pipeline 任务统计 (最近 7 天)
    const jobStats = await PipelineLogger.getJobStats()
    const totalRuns = jobStats.reduce((sum, j) => sum + j.total_runs, 0)
    const totalErrors = jobStats.reduce((sum, j) => sum + j.error_count, 0)
    const avgSuccessRate = jobStats.length > 0
      ? jobStats.reduce((sum, j) => sum + j.success_rate, 0) / jobStats.length
      : 0

    const topFailing = jobStats
      .filter(j => j.error_count > 0)
      .sort((a, b) => b.error_count - a.error_count)
      .slice(0, 5)

    // 2. 本周新增交易员 — estimated (weekly internal report, approximate is fine)
    const { count: newTraders } = await supabase
      .from('trader_sources')
      .select('id', { count: 'estimated', head: true })
      .gte('created_at', weekAgo)

    // 3. 交易员总数 — estimated (pg_class.reltuples, O(1))
    const { count: totalTraders } = await supabase
      .from('trader_sources')
      .select('id', { count: 'estimated', head: true })

    // 4. 最近失败 — 7 day window for a weekly report (default window is 2h for
    // real-time health alerts; weekly retrospective needs a longer horizon)
    const recentFailures = await PipelineLogger.getRecentFailures(10, 7 * 24 * 60)
    const uniqueFailedJobs = new Set(recentFailures.map(f => f.job_name))

    // 5. 数据新鲜度 — 过期数据源
    const { data: staleSources } = await supabase
      .from('trader_sources')
      .select('source')
      .lt('updated_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(100)

    const staleSourceCounts: Record<string, number> = {}
    staleSources?.forEach(s => {
      staleSourceCounts[s.source] = (staleSourceCounts[s.source] || 0) + 1
    })
    const staleExchanges = Object.entries(staleSourceCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)

    // 6. 用户增长 — estimated (weekly report, approximate headline number)
    const { count: newUsers } = await supabase
      .from('user_profiles')
      .select('id', { count: 'estimated', head: true })
      .gte('created_at', weekAgo)

    // 构建报告
    const failingJobLines = topFailing.length > 0
      ? topFailing.map(j => `  - ${j.job_name}: ${j.error_count} 错误 (成功率 ${(j.success_rate * 100).toFixed(0)}%)`).join('\n')
      : '  无'

    const staleLines = staleExchanges.length > 0
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

    const level = avgSuccessRate < 0.8 ? 'warning' : 'info'

    await sendAlert({
      title: `Arena 每周报告 — ${new Date().toISOString().split('T')[0]}`,
      message,
      level,
      details: {
        '总运行数': totalRuns,
        '错误数': totalErrors,
        '成功率': `${(avgSuccessRate * 100).toFixed(1)}%`,
        '新增交易员': newTraders ?? 0,
        '新增用户': newUsers ?? 0,
      },
    })

    logger.info('[每周报告] 已发送')
    await plog.success(totalRuns, { totalErrors, avgSuccessRate, newTraders, newUsers })
    return NextResponse.json({ ok: true, totalRuns, totalErrors, avgSuccessRate, newTraders, newUsers })
  } catch (err) {
    logger.error('[每周报告] 错误:', err)
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

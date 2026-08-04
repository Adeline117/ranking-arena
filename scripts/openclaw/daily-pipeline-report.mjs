#!/usr/bin/env node
/**
 * Arena Daily Pipeline Report (OpenClaw)
 *
 * Reports the authoritative API verdict and active-source freshness. Cron job
 * history and seven-day stats are diagnostics only.
 *
 * Usage:
 *   node scripts/openclaw/daily-pipeline-report.mjs
 */

import { fetchJsonWithDeadline, parsePipelineHealthResponse } from './pipeline-health-monitor.mjs'

const CRON_SECRET = process.env.CRON_SECRET
const API_URL = process.env.ARENA_URL
  ? `${process.env.ARENA_URL}/api/health/pipeline`
  : 'https://www.arenafi.org/api/health/pipeline'

function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sourceName(source) {
  return source?.platform || source?.displayName || 'unknown'
}

function sourceAge(source) {
  const age = source?.ageHours
  return typeof age === 'number' && Number.isFinite(age) ? `${age.toFixed(1)}h old` : 'no data'
}

export async function generateDailyReport({
  fetchImpl = globalThis.fetch,
  apiUrl = API_URL,
  cronSecret = CRON_SECRET,
  now = new Date(),
  logger = console,
  timeoutMs = 15000,
} = {}) {
  try {
    const reportDate = now instanceof Date ? now : new Date(now)
    if (!Number.isFinite(reportDate.getTime())) throw new Error('Daily report date is invalid')
    const payload = await fetchJsonWithDeadline({
      fetchImpl,
      url: apiUrl,
      init: {
        headers: { Authorization: `Bearer ${cronSecret || ''}` },
      },
      timeoutMs,
      label: 'Daily pipeline health request',
    })
    const health = parsePipelineHealthResponse(payload, { nowMs: reportDate.getTime() })
    const failedJobs = health.jobs.filter((job) => job?.health_status === 'failed')
    const stuckJobs = health.jobs.filter((job) => job?.health_status === 'stuck')
    const staleJobs = health.jobs.filter((job) => job?.health_status === 'stale')
    const criticalSources = health.platformHealth.filter((source) => source?.status === 'critical')
    const warningSources = health.platformHealth.filter((source) => source?.status === 'warning')

    const totalRuns7d = health.stats.reduce((sum, job) => sum + numeric(job?.total_runs), 0)
    const totalFailures7d = health.stats.reduce((sum, job) => sum + numeric(job?.error_count), 0)
    const lowSuccessRates = health.stats
      .filter((job) => job?.success_rate !== null && Number.isFinite(Number(job?.success_rate)))
      .map((job) => ({ ...job, successRate: numeric(job?.success_rate) }))
      .filter((job) => job.successRate < 70)
      .sort((a, b) => a.successRate - b.successRate)
      .slice(0, 5)

    const dayName = reportDate.toLocaleDateString('en-US', { weekday: 'long' })
    const dateStr = reportDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const statusEmoji =
      health.status === 'critical' ? '🔴' : health.status === 'degraded' ? '🟡' : '🟢'
    const averageSuccessRate = numeric(health.summary.avgSuccessRate7d)

    let report = `🏟 Arena Daily Report\n${dayName}, ${dateStr}\n\n`
    report += `Authoritative status: ${statusEmoji} ${health.status}\n`
    report += `Active sources: ${health.platformHealth.length}\n`
    report += `Success Rate (7d cron diagnostics): ${averageSuccessRate.toFixed(1)}%\n`
    report += `Total Runs (7d): ${totalRuns7d.toLocaleString()}\n`
    report += `Errors (7d): ${totalFailures7d.toLocaleString()}\n`
    report += `Cron Jobs: ${health.summary.healthyJobs ?? 0} healthy / ${health.summary.totalJobs ?? 0} total\n`

    const sourceIssues = [...criticalSources, ...warningSources]
    if (sourceIssues.length > 0) {
      report += `\nSource freshness (${sourceIssues.length}):\n`
      for (const source of sourceIssues.slice(0, 10)) {
        const marker = source.status === 'critical' ? '🚨' : '⚠️'
        report += `  ${marker} ${sourceName(source)}: ${source.status} (${sourceAge(source)})\n`
      }
    }

    if (failedJobs.length > 0) {
      report += `\nCron failures (${failedJobs.length}, diagnostic only):\n`
      for (const job of failedJobs.slice(0, 5)) {
        report += `  ❌ ${job.job_name || 'unknown'}: ${(job.error_message || 'Unknown').slice(0, 60)}\n`
      }
    }
    if (stuckJobs.length > 0) {
      report += `\nCron stuck (${stuckJobs.length}, diagnostic only):\n`
      for (const job of stuckJobs.slice(0, 5)) {
        report += `  ⏱️ ${job.job_name || 'unknown'}\n`
      }
    }
    if (staleJobs.length > 0) {
      report += `\nCron stale (${staleJobs.length}, diagnostic only):\n`
      for (const job of staleJobs.slice(0, 5)) {
        report += `  🕒 ${job.job_name || 'unknown'}\n`
      }
    }

    if (lowSuccessRates.length > 0) {
      report += '\nLow 7d cron success rates (diagnostic only):\n'
      for (const job of lowSuccessRates) {
        report += `  ${job.successRate.toFixed(1)}% - ${job.job_name || 'unknown'}\n`
      }
    }

    if (health.status === 'healthy') {
      report += '\n✅ Authoritative health verdict is healthy.\n'
    }

    logger.log(report)
    return {
      status: health.status,
      report,
      data: {
        healthy: health.summary.healthyJobs ?? 0,
        total: health.summary.totalJobs ?? 0,
        failed: failedJobs.length,
        stuck: stuckJobs.length,
        stale: staleJobs.length,
        criticalSources: criticalSources.length,
        warningSources: warningSources.length,
        successRate7d: averageSuccessRate,
        totalRuns7d,
        totalFailures7d,
      },
    }
  } catch (error) {
    const errorMessage = error?.message || String(error)
    logger.error('❌ Error generating daily report:', errorMessage)
    return {
      status: 'error',
      report: `❌ Daily report failed: ${errorMessage}`,
      data: null,
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await generateDailyReport()
  if (result.status === 'error' || result.status === 'critical') process.exitCode = 2
  else if (result.status === 'degraded') process.exitCode = 1
}

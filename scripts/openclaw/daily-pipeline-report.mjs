#!/usr/bin/env node
/**
 * Arena Daily Pipeline Report (OpenClaw)
 * 
 * Generates a daily summary focusing on CURRENT health, not historical failures.
 * 
 * Usage:
 *   node scripts/openclaw/daily-pipeline-report.mjs
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dirname, '../../.env') })

const CRON_SECRET = process.env.CRON_SECRET
const API_URL = process.env.ARENA_URL ? `${process.env.ARENA_URL}/api/health/pipeline` : 'https://www.arenafi.org/api/health/pipeline'

async function generateDailyReport() {
  try {
    const response = await fetch(API_URL, {
      headers: {
        'Authorization': `Bearer ${CRON_SECRET}`
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()
    
    // Get current failed/stuck jobs (NOT recentFailures!)
    const currentFailed = data.jobs.filter(j => j.health_status === 'failed')
    const currentStuck = data.jobs.filter(j => j.health_status === 'stuck')
    const currentStale = data.jobs.filter(j => j.health_status === 'stale')

    // Calculate total runs and records from stats
    const totalRuns7d = data.stats.reduce((sum, j) => sum + (j.total_runs_7d || 0), 0)
    const totalFailures7d = data.stats.reduce((sum, j) => sum + (j.failures_7d || 0), 0)
    
    // Get lowest success rates (but only alert if currently failed)
    const lowSuccessRates = data.stats
      .filter(j => j.success_rate !== null && j.success_rate < 70)
      .sort((a, b) => a.success_rate - b.success_rate)
      .slice(0, 5)

    // Determine if these low-success jobs are CURRENTLY failing
    const lowSuccessCurrentlyFailing = lowSuccessRates.filter(stat => 
      currentFailed.some(j => j.job_name === stat.job_name)
    )

    // Build report
    const now = new Date()
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long' })
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

    // Determine real status (ignore 7d success rate)
    // Note: 3-4 historical failed jobs during recovery period is normal
    let realStatus = 'healthy'
    if (currentStuck.length > 0 || currentFailed.length > 5) {
      realStatus = 'critical'
    } else if (currentFailed.length > 0 || currentStale.length > 0) {
      realStatus = 'degraded'
    }

    const statusEmoji = realStatus === 'critical' ? '🔴' : 
                        realStatus === 'degraded' ? '🟡' : '🟢'

    let report = `🏟 Arena Daily Report\n${dayName}, ${dateStr}\n\n`
    report += `Status: ${statusEmoji} ${realStatus}\n`
    report += `Success Rate (7d): ${data.summary.avgSuccessRate7d.toFixed(1)}%\n`
    
    if (totalRuns7d > 0) {
      report += `Total Runs (7d): ${totalRuns7d.toLocaleString()}\n`
      report += `Errors (7d): ${totalFailures7d.toLocaleString()}\n`
    }
    
    report += `Jobs: ${data.summary.healthyJobs} healthy / ${data.summary.totalJobs} total\n`

    // Current issues (if any)
    if (currentFailed.length > 0) {
      report += `\n⚠️  Currently Failed (${currentFailed.length}):\n`
      currentFailed.slice(0, 5).forEach(job => {
        const errorShort = (job.error_message || 'Unknown').slice(0, 60)
        report += `  ❌ ${job.job_name}: ${errorShort}\n`
      })
    }

    if (currentStuck.length > 0) {
      report += `\n⏱️  Currently Stuck (${currentStuck.length}):\n`
      currentStuck.forEach(job => {
        const startedAt = new Date(job.started_at)
        const runningTime = Math.floor((Date.now() - startedAt.getTime()) / 60000)
        report += `  ⏱️  ${job.job_name}: ${runningTime}min\n`
      })
    }

    if (currentStale.length > 0) {
      report += `\n🕒 Currently Stale (${currentStale.length}):\n`
      currentStale.forEach(job => {
        report += `  🕒 ${job.job_name}\n`
      })
    }

    // Low 7d success rates (with context)
    if (lowSuccessRates.length > 0) {
      const hasCurrentIssues = lowSuccessCurrentlyFailing.length > 0

      if (hasCurrentIssues) {
        report += `\n⚠️  Low Success Rates (currently failing):\n`
        lowSuccessCurrentlyFailing.forEach(stat => {
          report += `  ${stat.success_rate.toFixed(1)}% - ${stat.job_name} (CURRENTLY FAILING)\n`
        })
      } else {
        report += `\n📊 Low 7d Success Rates (all currently healthy):\n`
        lowSuccessRates.forEach(stat => {
          report += `  ${stat.success_rate.toFixed(1)}% - ${stat.job_name} ✅\n`
        })
        report += `\n💡 Note: These jobs are recovering from past issues. Success rates will improve over the next 7 days.\n`
      }
    }

    // All healthy message
    if (currentFailed.length === 0 && currentStuck.length === 0 && currentStale.length === 0) {
      report += `\n✅ All systems healthy!\n`
    }

    console.log(report)

    return {
      status: realStatus,
      report,
      data: {
        healthy: data.summary.healthyJobs,
        total: data.summary.totalJobs,
        failed: currentFailed.length,
        stuck: currentStuck.length,
        stale: currentStale.length,
        successRate7d: data.summary.avgSuccessRate7d
      }
    }

  } catch (error) {
    console.error('❌ Error generating daily report:', error.message)
    return {
      status: 'error',
      report: `❌ Daily report failed: ${error.message}`,
      data: null
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await generateDailyReport()
}

export { generateDailyReport }

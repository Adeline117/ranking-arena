#!/usr/bin/env node
/**
 * OpenClaw Health Monitor
 *
 * Runs on Mac Mini via OpenClaw scheduler.
 * Checks Arena health every 30 minutes, sends Telegram alerts on issues.
 *
 * Usage (standalone):
 *   CRON_SECRET=xxx TELEGRAM_BOT_TOKEN=xxx TELEGRAM_ALERT_CHAT_ID=xxx node scripts/openclaw/health-monitor.mjs
 *
 * Usage (OpenClaw):
 *   Configure as a skill that runs every 30 minutes
 *
 * Flags:
 *   check              Health check mode (default)
 *   daily              Daily report mode
 *   --with-auto-fix    Trigger auto-fix for failing fetchers after alert
 */

import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ARENA_URL = process.env.ARENA_URL || 'https://www.arenafi.org'
const CRON_SECRET = process.env.CRON_SECRET
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

// Auto-fix cooldown: 6 hours between fix attempts per platform
const AUTO_FIX_COOLDOWN_MS = 6 * 60 * 60 * 1000
const fixAttempts = new Map() // platform -> last attempt timestamp

if (!CRON_SECRET) {
  console.error('CRON_SECRET is required')
  process.exit(1)
}

async function checkBasicHealth() {
  const res = await fetch(`${ARENA_URL}/api/health`, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  })
  return res.json()
}

async function checkPipelineHealth() {
  const res = await fetch(`${ARENA_URL}/api/health/pipeline`, {
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(30000),
  })
  return res.json()
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram disabled]', text)
    return
  }

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
  } catch (err) {
    console.error('Telegram send failed:', err.message)
  }
}

function formatDuration(ms) {
  if (!ms) return 'N/A'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

async function runHealthCheck() {
  const issues = []
  let basicHealth, pipelineHealth

  // 1. Basic health
  try {
    basicHealth = await checkBasicHealth()
    if (basicHealth.status === 'unhealthy') {
      issues.push(`🚨 System UNHEALTHY: DB=${basicHealth.checks?.database?.status}, Redis=${basicHealth.checks?.redis?.status}`)
    } else if (basicHealth.status === 'degraded') {
      issues.push(`⚠️ System degraded: ${JSON.stringify(basicHealth.checks)}`)
    }
  } catch (err) {
    issues.push(`🚨 Arena UNREACHABLE: ${err.message}`)
  }

  // 2. Pipeline health
  try {
    pipelineHealth = await checkPipelineHealth()

    if (pipelineHealth.status === 'critical') {
      const { failedJobs, stuckJobs, staleJobs } = pipelineHealth.summary || {}
      issues.push(`🚨 Pipeline CRITICAL: ${failedJobs} failed, ${stuckJobs} stuck, ${staleJobs} stale`)

      // List specific failures
      if (pipelineHealth.recentFailures?.length) {
        for (const f of pipelineHealth.recentFailures.slice(0, 5)) {
          issues.push(`  ❌ ${f.job_name}: ${f.error_message?.slice(0, 100) || 'unknown'}`)
        }
      }
    } else if (pipelineHealth.status === 'degraded') {
      const { failedJobs, staleJobs } = pipelineHealth.summary || {}
      issues.push(`⚠️ Pipeline degraded: ${failedJobs} failed, ${staleJobs} stale`)
    }
  } catch (err) {
    issues.push(`⚠️ Pipeline check failed: ${err.message}`)
  }

  // 3. Send alert if issues found
  if (issues.length > 0) {
    const msg = `<b>🏟 Arena Health Alert</b>\n\n${issues.join('\n')}\n\n<i>${new Date().toISOString()}</i>`
    await sendTelegram(msg)
    console.log('ALERT:', issues.join(' | '))

    // 4. Trigger auto-fix if --with-auto-fix flag is set
    if (process.argv.includes('--with-auto-fix') && pipelineHealth) {
      await triggerAutoFix(pipelineHealth)
    }

    return { status: 'alert', issues }
  }

  console.log(`✅ All healthy (basic: ${basicHealth?.status}, pipeline: ${pipelineHealth?.status})`)
  return { status: 'healthy' }
}

async function triggerAutoFix(pipelineHealth) {
  const { spawn } = await import('child_process')
  const autoFixScript = path.join(__dirname, 'auto-fix.mjs')
  const failingJobs = (pipelineHealth.recentFailures || [])
    .filter(f => f.job_name?.startsWith('fetch-traders-'))
    .map(f => ({
      platform: f.job_name.replace('fetch-traders-', ''),
      reason: classifyErrorMsg(f.error_message),
    }))
  if (failingJobs.length === 0) { console.log('[auto-fix] No fetcher failures'); return }
  const seen = new Set()
  for (const { platform, reason } of failingJobs) {
    if (seen.has(platform)) continue
    seen.add(platform)
    const lastAttempt = fixAttempts.get(platform) || 0
    if (Date.now() - lastAttempt < AUTO_FIX_COOLDOWN_MS) { console.log('[auto-fix] Cooldown: ' + platform); continue }
    fixAttempts.set(platform, Date.now())
    console.log('[auto-fix] Fixing ' + platform + ' (' + reason + ')')
    try {
      const proc = spawn('node', [autoFixScript, platform, '--reason', reason], {
        cwd: path.dirname(__dirname), stdio: 'inherit', timeout: 300000,
      })
      proc.on('close', (code) => console.log('[auto-fix] ' + platform + ' exit: ' + code))
    } catch (err) { console.error('[auto-fix] Launch failed for ' + platform, err.message) }
  }
}

function classifyErrorMsg(msg) {
  if (!msg) return 'unknown'
  const m = msg.toLowerCase()
  if (m.includes('geo') || m.includes('451')) return 'geo_blocked'
  if (m.includes('waf') || m.includes('cloudflare') || m.includes('access denied')) return 'waf_blocked'
  if (m.includes('404') || m.includes('not found')) return 'endpoint_gone'
  if (m.includes('429') || m.includes('rate limit')) return 'rate_limited'
  if (m.includes('timeout') || m.includes('abort')) return 'timeout'
  if (m.includes('401') || m.includes('unauthorized')) return 'auth_required'
  return 'unknown'
}

async function runDailyReport() {
  let pipelineHealth

  try {
    pipelineHealth = await checkPipelineHealth()
  } catch (err) {
    await sendTelegram(`<b>🏟 Arena Daily Report</b>\n\n❌ Failed to fetch pipeline data: ${err.message}`)
    return
  }

  const { summary, stats } = pipelineHealth

  // Calculate totals from stats
  const totalRuns = stats?.reduce((s, j) => s + (j.total_runs || 0), 0) || 0
  const totalSuccess = stats?.reduce((s, j) => s + (j.success_count || 0), 0) || 0
  const totalErrors = stats?.reduce((s, j) => s + (j.error_count || 0), 0) || 0
  const totalRecords = stats?.reduce((s, j) => s + (j.total_records_processed || 0), 0) || 0

  const overallSuccessRate = totalRuns > 0 ? ((totalSuccess / totalRuns) * 100).toFixed(1) : 'N/A'

  // Find worst performing jobs
  const worstJobs = (stats || [])
    .filter(j => j.success_rate < 100)
    .sort((a, b) => (a.success_rate || 0) - (b.success_rate || 0))
    .slice(0, 5)

  let report = `<b>🏟 Arena Daily Report</b>\n`
  report += `<i>${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</i>\n\n`

  // Overall status
  const statusEmoji = summary?.failedJobs === 0 ? '🟢' : summary?.failedJobs < 3 ? '🟡' : '🔴'
  report += `<b>Status:</b> ${statusEmoji} ${pipelineHealth.status}\n`
  report += `<b>Success Rate (7d):</b> ${overallSuccessRate}%\n`
  report += `<b>Total Runs (7d):</b> ${totalRuns}\n`
  report += `<b>Records Processed:</b> ${totalRecords.toLocaleString()}\n`
  report += `<b>Errors:</b> ${totalErrors}\n`
  report += `<b>Jobs:</b> ${summary?.healthyJobs || 0} healthy / ${summary?.totalJobs || 0} total\n`

  if (worstJobs.length > 0) {
    report += `\n<b>Lowest Success Rates:</b>\n`
    for (const j of worstJobs) {
      report += `  ${j.success_rate}% - ${j.job_name}\n`
    }
  }

  if (summary?.staleJobs > 0 || summary?.stuckJobs > 0) {
    report += `\n⚠️ ${summary.staleJobs} stale, ${summary.stuckJobs} stuck jobs`
  }

  await sendTelegram(report)
  console.log('Daily report sent')
}

// Main
const mode = process.argv[2] || 'check'

if (mode === 'daily') {
  runDailyReport().catch(err => {
    console.error('Daily report failed:', err)
    process.exit(1)
  })
} else {
  runHealthCheck().catch(err => {
    console.error('Health check failed:', err)
    process.exit(1)
  })
}

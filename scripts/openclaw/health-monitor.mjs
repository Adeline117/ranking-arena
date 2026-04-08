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
import { config as dotenvConfig } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dirname, '../../.env') })

const ARENA_URL = process.env.ARENA_URL || 'https://www.arenafi.org'
const CRON_SECRET = process.env.CRON_SECRET
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

// Auto-fix cooldown: 6 hours between fix attempts per platform
const AUTO_FIX_COOLDOWN_MS = 6 * 60 * 60 * 1000
const fixAttempts = new Map() // platform -> last attempt timestamp

// Alert dedup: don't re-send same issue within cooldown
import fs from 'fs'
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000 // 2 hours between same-issue alerts
const ALERT_STATE_FILE = path.resolve(__dirname, '.health-monitor-state.json')

function loadAlertState() {
  try {
    if (fs.existsSync(ALERT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf-8'))
    }
  } catch { /* ignore */ }
  return {}
}

function saveAlertState(state) {
  try {
    fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(state))
  } catch { /* ignore */ }
}

/**
 * Check if we should send this alert (dedup by issue fingerprint).
 * Returns true if alert should be sent.
 */
function shouldSendAlert(issueFingerprint) {
  const state = loadAlertState()
  const lastSent = state[issueFingerprint]
  if (lastSent && Date.now() - lastSent < ALERT_COOLDOWN_MS) {
    return false
  }
  state[issueFingerprint] = Date.now()
  // Cleanup entries older than 24h
  for (const [key, ts] of Object.entries(state)) {
    if (Date.now() - ts > 24 * 60 * 60 * 1000) delete state[key]
  }
  saveAlertState(state)
  return true
}

// Dead/blocked platforms - skip in alerts & auto-fix
// Synced 2026-04-03 — skip dead platforms in alerts & auto-fix
const DEAD_PLATFORMS = new Set([
  'perpetual_protocol', 'whitebit', 'bitmart', 'btse',
  'kwenta', 'mux', 'synthetix', 'paradex',
  'kucoin',      // copy trading discontinued 2026-03
  'phemex',      // API 404 since 2026-04
  'bingx',       // empty leaderboard data
  'bingx_spot',  // no leaderboard API
  'bitget_spot', // permanently disabled (no leaderboard API)
  'lbank',       // API 404 since 2026-04 (copy-trading endpoint removed)
  'weex',        // 75% timeout rate
  'gains',       // leaderboard endpoint 404 since 2026-04-07 (all 3 chains)
  'bybit', 'bybit_spot', // VPS scraper down 2026-04-08, direct API 404
  'vertex', 'apex_pro', 'rabbitx', // DNS dead / no API
])

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

  // 3. Send alert if issues found (with dedup)
  if (issues.length > 0) {
    // Fingerprint = sorted issue types (ignore specific timestamps/details)
    const fingerprint = issues.map(i => i.replace(/\d+/g, 'N').slice(0, 60)).sort().join('|')

    if (shouldSendAlert(fingerprint)) {
      const msg = `<b>🏟 Arena Health Alert</b>\n\n${issues.join('\n')}\n\n<i>${new Date().toISOString()}</i>`
      await sendTelegram(msg)
      console.log('ALERT SENT:', issues.join(' | '))
    } else {
      console.log('ALERT DEDUPED (same issue within 2h):', issues.join(' | '))
    }

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
    .filter(f => f.job_name?.includes('fetch-traders'))
    .map(f => ({
      platform: f.job_name.replace(/^batch-fetch-traders-/, ''),
      reason: classifyErrorMsg(f.error_message),
    }))
    .filter(f => !DEAD_PLATFORMS.has(f.platform))
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

// ============================================
// 用户活动数据
// ============================================

async function fetchActivityStats() {
  try {
    const res = await fetch(`${ARENA_URL}/api/analytics/activity`, {
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json.activity || null
  } catch (err) {
    console.error('获取活动数据失败:', err.message)
    return null
  }
}

// ============================================
// 每日报告
// ============================================

async function runDailyReport() {
  let pipelineHealth
  let activity

  try {
    ;[pipelineHealth, activity] = await Promise.all([
      checkPipelineHealth(),
      fetchActivityStats(),
    ])
  } catch (err) {
    await sendTelegram(`<b>📊 Arena 每日报告</b>\n\n获取数据失败: ${err.message}`)
    return
  }

  const { summary, stats } = pipelineHealth
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' })

  const totalRuns = stats?.reduce((s, j) => s + (j.total_runs || 0), 0) || 0
  const totalSuccess = stats?.reduce((s, j) => s + (j.success_count || 0), 0) || 0
  const totalErrors = stats?.reduce((s, j) => s + (j.error_count || 0), 0) || 0

  const overallSuccessRate = totalRuns > 0 ? ((totalSuccess / totalRuns) * 100).toFixed(1) : 'N/A'

  const worstJobs = (stats || [])
    .filter(j => j.success_rate < 100)
    .sort((a, b) => (a.success_rate || 0) - (b.success_rate || 0))
    .slice(0, 3)

  const statusEmoji = summary?.failedJobs === 0 ? '🟢' : summary?.failedJobs < 3 ? '🟡' : '🔴'

  let report = `📊<b>【日报】${today}</b>\n\n`

  // 🔧 系统状态
  report += `🔧 <b>系统状态</b>\n`
  report += `- Pipeline：${statusEmoji} ${summary?.healthyJobs || 0}/${summary?.totalJobs || 0} 正常`
  if (summary?.failedJobs > 0) {
    report += `，${summary.failedJobs} 异常`
  }
  report += `\n`
  report += `- 成功率 (7天)：${overallSuccessRate}%\n`
  report += `- 错误数：${totalErrors}\n`

  if (worstJobs.length > 0) {
    report += `- 错误 Top ${worstJobs.length}：${worstJobs.map(j => `${j.job_name}(${j.success_rate}%)`).join('、')}\n`
  }

  if (summary?.staleJobs > 0 || summary?.stuckJobs > 0) {
    report += `- ⚠️ ${summary.staleJobs} 过期, ${summary.stuckJobs} 卡住\n`
  }

  // 📈 流量与用户
  report += `\n📈 <b>流量与用户</b>\n`
  if (activity) {
    report += `- 今日新注册：${activity.signups}\n`
    report += `- 总注册用户：${activity.total_users}\n`
    report += `- 今日活跃用户：${activity.active_users}\n`
  } else {
    report += `- <i>活动数据获取失败</i>\n`
  }

  // 💬 社区活动
  report += `\n💬 <b>社区活动</b>\n`
  if (activity) {
    report += `- 新建小组：${activity.new_groups} 个\n`
    report += `- 新发帖子：${activity.new_posts} 条\n`
    report += `- 新评论：${activity.new_comments} 条\n`
    report += `- 新关注（用户间）：${activity.new_follows}\n`
  } else {
    report += `- <i>社区数据获取失败</i>\n`
  }

  // 👤 交易员认领
  report += `\n👤 <b>交易员认领</b>\n`
  if (activity) {
    report += `- 今日新认领：${activity.new_claims} 个\n`
    report += `- 总已认领：${activity.total_verified} 个\n`
    report += `- 待审核认领：${activity.pending_claims} 个\n`
  } else {
    report += `- <i>认领数据获取失败</i>\n`
  }

  await sendTelegram(report)
  console.log('每日报告已发送')
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

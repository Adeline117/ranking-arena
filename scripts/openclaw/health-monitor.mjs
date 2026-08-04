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
 * Modes:
 *   check              Health check mode (default)
 *   daily              Daily report mode
 */

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { config as dotenvConfig } from 'dotenv'
import { findStaleActivePlatforms, parseBasicHealthResponse } from './health-monitor-contract.mjs'
import { fetchJsonWithDeadline, parsePipelineHealthResponse } from './pipeline-health-monitor.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dirname, '../../.env'), quiet: true })

const ARENA_URL = process.env.ARENA_URL || 'https://www.arenafi.org'
const CRON_SECRET = process.env.CRON_SECRET
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

// Alert dedup: don't re-send same issue within cooldown
import fs from 'fs'
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000 // 2 hours between same-issue alerts
const ALERT_STATE_FILE = path.resolve(__dirname, '.health-monitor-state.json')

function loadAlertState() {
  try {
    if (fs.existsSync(ALERT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf-8'))
    }
  } catch {
    /* ignore */
  }
  return {}
}

function saveAlertState(state) {
  try {
    fs.writeFileSync(ALERT_STATE_FILE, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

/**
 * Check if we should send this alert (dedup by issue fingerprint).
 * Returns true if alert should be sent.
 */
function shouldSendAlert(issueFingerprint) {
  const state = loadAlertState()
  const entry = state[issueFingerprint]
  // Back-compat: old state stored a bare timestamp.
  const lastSent = typeof entry === 'number' ? entry : entry?.ts
  const streak = typeof entry === 'object' ? (entry?.streak ?? 1) : 1

  // Chronic-condition backoff: a fingerprint that keeps firing doubles its
  // cooldown each consecutive send (2h → 4h → 8h → 16h → cap 24h). A
  // permanently-degraded panel used to page every single 2h cron run —
  // 12 walls of text a day saying the same thing. Recovery (a run with no
  // issues) clears the state file entry, so a NEW incident pages immediately.
  const effectiveCooldown = Math.min(
    ALERT_COOLDOWN_MS * Math.pow(2, Math.max(0, streak - 1)),
    24 * 60 * 60 * 1000
  )
  if (lastSent && Date.now() - lastSent < effectiveCooldown) {
    return false
  }
  return true
}

function recordAlertSent(issueFingerprint) {
  const state = loadAlertState()
  const entry = state[issueFingerprint]
  const lastSent = typeof entry === 'number' ? entry : entry?.ts
  const streak = typeof entry === 'object' ? (entry?.streak ?? 1) : 1
  state[issueFingerprint] = { ts: Date.now(), streak: lastSent ? streak + 1 : 1 }
  // Cleanup entries older than 48h (covers the 24h max backoff window)
  for (const [key, val] of Object.entries(state)) {
    const ts = typeof val === 'number' ? val : val?.ts
    if (!ts || Date.now() - ts > 48 * 60 * 60 * 1000) delete state[key]
  }
  saveAlertState(state)
}

export async function checkBasicHealth({
  fetchImpl = globalThis.fetch,
  arenaUrl = ARENA_URL,
  timeoutMs = 30000,
  nowMs = Date.now(),
} = {}) {
  // 30s timeout — /api/health runs DB + Redis + freshness + VPS checks,
  // each with 5s internal cap, so worst case ~20s. 15s was too tight.
  const payload = await fetchJsonWithDeadline({
    fetchImpl,
    url: `${arenaUrl}/api/health`,
    init: { headers: { 'Cache-Control': 'no-cache' } },
    timeoutMs,
    label: 'Basic health request',
  })
  return parseBasicHealthResponse(payload, { nowMs })
}

export async function checkPipelineHealthSnapshot({
  fetchImpl = globalThis.fetch,
  arenaUrl = ARENA_URL,
  cronSecret = CRON_SECRET,
  timeoutMs = 60000,
  nowMs = Date.now(),
} = {}) {
  // 60s timeout: /api/health/pipeline does 4 parallel DB queries + RPC; under load
  // the 30s ceiling was too tight and caused false "Pipeline check failed: timeout"
  // alerts. The route itself caches results for 2min so this is mostly a cache-miss guard.
  const payload = await fetchJsonWithDeadline({
    fetchImpl,
    url: `${arenaUrl}/api/health/pipeline`,
    init: {
      headers: {
        Authorization: `Bearer ${cronSecret || ''}`,
        'Cache-Control': 'no-cache',
      },
    },
    timeoutMs,
    label: 'Pipeline health request',
  })
  return parsePipelineHealthResponse(payload, { nowMs })
}

export async function sendTelegram(
  text,
  {
    fetchImpl = globalThis.fetch,
    botToken = TELEGRAM_BOT_TOKEN,
    chatId = TELEGRAM_CHAT_ID,
    timeoutMs = 15000,
  } = {}
) {
  if (!botToken || !chatId) {
    throw new Error('Telegram alert credentials are required')
  }

  const payload = await fetchJsonWithDeadline({
    fetchImpl,
    url: `https://api.telegram.org/bot${botToken}/sendMessage`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    },
    timeoutMs,
    label: 'Telegram alert delivery',
  })
  if (payload?.ok !== true) {
    throw new Error('Telegram API rejected the alert')
  }
  return payload
}

function formatDuration(ms) {
  if (!ms) return 'N/A'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export async function runHealthCheck() {
  const issues = []
  // categories: stable fingerprint keys that don't change with counts/job lists
  const categories = new Set()
  let basicHealth, pipelineHealth

  // 1. Basic health
  try {
    basicHealth = await checkBasicHealth()
    if (basicHealth.status === 'unhealthy') {
      issues.push(
        `🚨 System UNHEALTHY: DB=${basicHealth.checks?.database?.status}, Redis=${basicHealth.checks?.redis?.status}`
      )
      categories.add('system:unhealthy')
    } else if (basicHealth.status === 'degraded') {
      // Summarize which sub-check failed instead of dumping full JSON blob —
      // the JSON blob caused unstable fingerprints (latency numbers kept changing).
      const failed = Object.entries(basicHealth.checks || {})
        .filter(([, v]) => v?.status === 'fail')
        .map(([k, v]) => `${k}=${v.message?.slice(0, 80) || 'fail'}`)
        .join(', ')
      issues.push(`⚠️ System degraded: ${failed || 'unknown'}`)
      // fingerprint by which checks failed, not by latency numbers
      for (const [k, v] of Object.entries(basicHealth.checks || {})) {
        if (v?.status === 'fail') categories.add(`system:degraded:${k}`)
      }
    }
  } catch (err) {
    issues.push(`🚨 Arena UNREACHABLE: ${err.message}`)
    categories.add('system:unreachable')
  }

  // 2. Pipeline health
  try {
    pipelineHealth = await checkPipelineHealthSnapshot()

    if (pipelineHealth.status === 'critical') {
      const { failedJobs, stuckJobs, staleJobs } = pipelineHealth.summary || {}
      issues.push(
        `🚨 Pipeline CRITICAL: ${failedJobs} failed, ${stuckJobs} stuck, ${staleJobs} stale`
      )
      categories.add('pipeline:critical')

      // /api/health/pipeline already filters job failures against the server's
      // current lifecycle contract. Do not maintain a second client-side dead
      // list: it previously hid revived active sources such as LBank and KuCoin.
      if (pipelineHealth.recentFailures?.length) {
        for (const f of pipelineHealth.recentFailures.slice(0, 5)) {
          issues.push(`  ❌ ${f.job_name}: ${f.error_message?.slice(0, 100) || 'unknown'}`)
        }
      }
    } else if (pipelineHealth.status === 'degraded') {
      const { failedJobs, staleJobs } = pipelineHealth.summary || {}
      issues.push(`⚠️ Pipeline degraded: ${failedJobs} failed, ${staleJobs} stale`)
      categories.add('pipeline:degraded')
    }

    // Surface silent background failures (fireAndForget escalations).
    // Retro 2026-04-09: before this, they only lived in-memory per instance
    // and were invisible to OpenClaw.
    if (pipelineHealth.backgroundFailures?.length) {
      const top = pipelineHealth.backgroundFailures.slice(0, 3)
      for (const bf of top) {
        issues.push(
          `  ⚠️ Background: ${bf.label} (${bf.count}x): ${(bf.lastError || '').slice(0, 80)}`
        )
      }
      categories.add(`pipeline:background-failures:${pipelineHealth.backgroundFailures.length}`)
    }
  } catch (err) {
    issues.push(`⚠️ Pipeline check failed: ${err.message}`)
    categories.add('pipeline:check-failed')
  }

  // 3. Infrastructure input validation (root-root-root cause prevention)
  // These catch problems BEFORE they cascade into pipeline failures.

  // 3a. VPS connectivity — detect port drift AND auth mismatch before fetchers fail
  for (const [name, url] of [
    ['VPS Proxy (3456)', process.env.VPS_PROXY_SG],
    ['VPS Scraper (3457)', process.env.VPS_SCRAPER_SG || process.env.VPS_SCRAPER_HOST],
  ]) {
    if (!url) continue
    try {
      const cleanUrl = url.replace(/\\n$/, '').trim()
      const res = await fetch(`${cleanUrl}/health`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        issues.push(`⚠️ ${name}: HTTP ${res.status}`)
        categories.add('infra:vps-degraded')
      }
    } catch {
      issues.push(`🚨 ${name} UNREACHABLE`)
      categories.add('infra:vps-dead')
    }
  }

  // 3a2. VPS proxy AUTH check — catches key mismatch (root cause of 7h Binance outage 2026-04-22)
  // /health returns 200 even when proxy key is wrong. Must test actual /proxy auth.
  const vpsProxyUrl = process.env.VPS_PROXY_SG
  const vpsProxyKey = process.env.VPS_PROXY_KEY
  if (vpsProxyUrl && vpsProxyKey) {
    try {
      const cleanUrl = vpsProxyUrl.replace(/\\n$/, '').trim()
      const res = await fetch(`${cleanUrl}/proxy`, {
        method: 'POST',
        headers: { 'X-Proxy-Key': vpsProxyKey.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `https://api.copin.io/leaderboards/page?protocol=DYDX&limit=1&offset=0&statisticType=MONTH&queryDate=${Date.now()}`,
          method: 'GET',
        }),
        signal: AbortSignal.timeout(10000),
      })
      if (res.status === 401) {
        issues.push(
          `🔴 VPS PROXY AUTH FAILED (${res.status}) — key mismatch between app and VPS! Binance/Bitget will fail.`
        )
        categories.add('infra:vps-auth-mismatch')
      }
    } catch (err) {
      issues.push(`⚠️ VPS proxy auth check failed: ${err.message}`)
      categories.add('infra:vps-auth-check-error')
    }
  }

  // 3b. Crontab validation — detect dead script references
  try {
    const { execSync } = await import('child_process')
    const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8', timeout: 5000 })
    const deadScripts = []
    for (const line of crontab.split('\n')) {
      const match = line.match(/scripts\/openclaw\/([^\s>]+\.mjs)/)
      if (match) {
        const scriptPath = path.resolve(__dirname, match[1])
        try {
          await import('fs').then((fs) => fs.accessSync(scriptPath))
        } catch {
          deadScripts.push(match[1])
        }
      }
    }
    if (deadScripts.length > 0) {
      issues.push(`🚨 Crontab dead scripts: ${deadScripts.join(', ')}`)
      categories.add('infra:crontab-dead')
    }
  } catch {
    /* crontab check non-critical */
  }

  // 3c. Stale platform detection — catch silent data source death
  // Root cause fix: currentCount is always 0 (per-platform count queries were removed
  // from /api/health/pipeline to reduce DB load). Only use ageHours as signal.
  // Alert if a platform has no lastUpdate (ageHours=null) or is stale >threshold.
  // Default 48h; BloFin uses 12h (Mac Mini only, no fallback — need fast detection).
  const platforms = pipelineHealth?.platformHealth || []
  if (Array.isArray(platforms) && platforms.length > 0) {
    // platformHealth is registry-backed: present means active, absent means
    // inactive/retired. Every returned row must be evaluated, including a
    // revived source whose old static label once said "dead".
    const stalePlatforms = findStaleActivePlatforms(platforms).map(
      ({ platform, ageHours, thresholdHours }) =>
        `${platform}(${ageHours === null ? 'no data' : ageHours.toFixed(0) + 'h stale'}, threshold: ${thresholdHours}h)`
    )
    if (stalePlatforms.length > 0) {
      issues.push(`🚨 Stale platforms: ${stalePlatforms.join(', ')}`)
      categories.add('data:stale-platforms')
    }
  }

  // 4. Send alert if issues found (with dedup)
  if (issues.length > 0) {
    // Fingerprint is category-based only — ignore counts, job lists, and specific
    // error text. This means any "Pipeline CRITICAL" condition dedupes to a single
    // alert per 2h, regardless of which specific jobs are failing that run.
    const fingerprint = [...categories].sort().join('|') || 'unknown'

    if (shouldSendAlert(fingerprint)) {
      const msg = `<b>🏟 Arena Health Alert</b>\n\n${issues.join('\n')}\n\n<i>${new Date().toISOString()}</i>`
      await sendTelegram(msg)
      recordAlertSent(fingerprint)
      console.log('ALERT SENT:', issues.join(' | '))
    } else {
      console.log('ALERT DEDUPED (same category within 2h):', issues.join(' | '))
    }

    return { status: 'alert', issues }
  }

  // Recovery: clear the dedup/backoff state so the NEXT incident pages
  // immediately instead of inheriting a chronic-condition cooldown.
  saveAlertState({})

  console.log(`✅ All healthy (basic: ${basicHealth?.status}, pipeline: ${pipelineHealth?.status})`)
  return { status: 'healthy' }
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

export async function runDailyReport() {
  let pipelineHealth
  let activity

  try {
    ;[pipelineHealth, activity] = await Promise.all([
      checkPipelineHealthSnapshot(),
      fetchActivityStats(),
    ])
  } catch (err) {
    await sendTelegram(`<b>📊 Arena 每日报告</b>\n\n获取数据失败: ${err.message}`)
    return { status: 'error' }
  }

  const { summary, stats } = pipelineHealth
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Shanghai',
  })

  const totalRuns = stats?.reduce((s, j) => s + (j.total_runs || 0), 0) || 0
  const totalSuccess = stats?.reduce((s, j) => s + (j.success_count || 0), 0) || 0
  const totalErrors = stats?.reduce((s, j) => s + (j.error_count || 0), 0) || 0

  const overallSuccessRate = totalRuns > 0 ? ((totalSuccess / totalRuns) * 100).toFixed(1) : 'N/A'

  const worstJobs = (stats || [])
    .filter((j) => j.success_rate < 100)
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
    report += `- 错误 Top ${worstJobs.length}：${worstJobs.map((j) => `${j.job_name}(${j.success_rate}%)`).join('、')}\n`
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
  return { status: pipelineHealth.status }
}

// Main
const mode = process.argv[2] || 'check'
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  if (!CRON_SECRET || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('CRON_SECRET and Telegram alert credentials are required')
    process.exitCode = 2
  } else if (mode === 'daily') {
    runDailyReport()
      .then((result) => {
        if (result?.status === 'error' || result?.status === 'critical') process.exitCode = 2
        else if (result?.status === 'degraded') process.exitCode = 1
      })
      .catch((err) => {
        console.error('Daily report failed:', err.message || String(err))
        process.exitCode = 2
      })
  } else {
    runHealthCheck()
      .then((result) => {
        if (result.status === 'alert') process.exitCode = 1
      })
      .catch((err) => {
        console.error('Health check failed:', err.message || String(err))
        process.exitCode = 2
      })
  }
}

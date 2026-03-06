#!/usr/bin/env node
/**
 * OpenClaw 健康监控
 *
 * Mac Mini 上通过 OpenClaw 调度运行。
 * 每 30 分钟检查 Arena 健康，异常时发 Telegram 告警。
 * 正常时只写日志，不发消息（控制 token 消耗）。
 *
 * 用法:
 *   node scripts/openclaw/health-monitor.mjs           # 健康检查（默认）
 *   node scripts/openclaw/health-monitor.mjs daily      # 每日报告
 *   node scripts/openclaw/health-monitor.mjs --with-auto-fix  # 异常时自动修复
 *
 * 环境变量:
 *   CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID
 */

import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ARENA_URL = process.env.ARENA_URL || 'https://www.arenafi.org'
const CRON_SECRET = process.env.CRON_SECRET
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

// 自动修复冷却: 每个平台 6 小时
const AUTO_FIX_COOLDOWN_MS = 6 * 60 * 60 * 1000
const fixAttempts = new Map()

if (!CRON_SECRET) {
  console.error('CRON_SECRET 未设置')
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
    console.log('[Telegram 未配置]', text)
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
    console.error('Telegram 发送失败:', err.message)
  }
}

// ============================================
// 健康检查 - 只在异常时发 Telegram
// ============================================

async function runHealthCheck() {
  const issues = []
  let basicHealth, pipelineHealth

  // 1. 基础健康
  try {
    basicHealth = await checkBasicHealth()
    if (basicHealth.status === 'unhealthy') {
      issues.push(`系统不健康: DB=${basicHealth.checks?.database?.status}, Redis=${basicHealth.checks?.redis?.status}`)
    } else if (basicHealth.status === 'degraded') {
      issues.push(`系统降级: ${JSON.stringify(basicHealth.checks)}`)
    }
  } catch (err) {
    issues.push(`Arena 无法访问: ${err.message}`)
  }

  // 2. Pipeline 健康
  try {
    pipelineHealth = await checkPipelineHealth()

    if (pipelineHealth.status === 'critical') {
      const { failedJobs, stuckJobs, staleJobs } = pipelineHealth.summary || {}
      issues.push(`Pipeline 严重: ${failedJobs} 失败, ${stuckJobs} 卡住, ${staleJobs} 过期`)

      if (pipelineHealth.recentFailures?.length) {
        for (const f of pipelineHealth.recentFailures.slice(0, 5)) {
          issues.push(`  - ${f.job_name}: ${f.error_message?.slice(0, 100) || '未知'}`)
        }
      }
    } else if (pipelineHealth.status === 'degraded') {
      const { failedJobs, staleJobs } = pipelineHealth.summary || {}
      issues.push(`Pipeline 降级: ${failedJobs} 失败, ${staleJobs} 过期`)
    }
  } catch (err) {
    issues.push(`Pipeline 检查失败: ${err.message}`)
  }

  // 3. 有异常才发 Telegram
  if (issues.length > 0) {
    const msg = `<b>\u{1F534} Arena 健康告警</b>\n\n${issues.join('\n')}\n\n<i>${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</i>`
    await sendTelegram(msg)
    console.log('告警:', issues.join(' | '))

    // 4. 自动修复
    if (process.argv.includes('--with-auto-fix') && pipelineHealth) {
      await triggerAutoFix(pipelineHealth)
    }

    return { status: 'alert', issues }
  }

  // 正常时只写日志，不发 Telegram
  console.log(`\u{2705} 一切正常 (基础: ${basicHealth?.status}, Pipeline: ${pipelineHealth?.status})`)
  return { status: 'healthy' }
}

// ============================================
// 自动修复
// ============================================

async function triggerAutoFix(pipelineHealth) {
  const { spawn } = await import('child_process')
  const autoFixScript = path.join(__dirname, 'auto-fix.mjs')
  const failingJobs = (pipelineHealth.recentFailures || [])
    .filter(f => f.job_name?.startsWith('fetch-traders-'))
    .map(f => ({
      platform: f.job_name.replace('fetch-traders-', ''),
      reason: classifyErrorMsg(f.error_message),
    }))
  if (failingJobs.length === 0) { console.log('[自动修复] 无 fetcher 失败'); return }
  const seen = new Set()
  for (const { platform, reason } of failingJobs) {
    if (seen.has(platform)) continue
    seen.add(platform)
    const lastAttempt = fixAttempts.get(platform) || 0
    if (Date.now() - lastAttempt < AUTO_FIX_COOLDOWN_MS) { console.log('[自动修复] 冷却中: ' + platform); continue }
    fixAttempts.set(platform, Date.now())
    console.log('[自动修复] 修复 ' + platform + ' (' + reason + ')')
    try {
      const proc = spawn('node', [autoFixScript, platform, '--reason', reason], {
        cwd: path.dirname(__dirname), stdio: 'inherit', timeout: 300000,
      })
      proc.on('close', (code) => console.log('[自动修复] ' + platform + ' 退出码: ' + code))
    } catch (err) { console.error('[自动修复] 启动失败: ' + platform, err.message) }
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
// 每日报告
// ============================================

async function runDailyReport() {
  let pipelineHealth

  try {
    pipelineHealth = await checkPipelineHealth()
  } catch (err) {
    await sendTelegram(`<b>\u{1F4CA} Arena 每日报告</b>\n\n获取 Pipeline 数据失败: ${err.message}`)
    return
  }

  const { summary, stats } = pipelineHealth

  const totalRuns = stats?.reduce((s, j) => s + (j.total_runs || 0), 0) || 0
  const totalSuccess = stats?.reduce((s, j) => s + (j.success_count || 0), 0) || 0
  const totalErrors = stats?.reduce((s, j) => s + (j.error_count || 0), 0) || 0
  const totalRecords = stats?.reduce((s, j) => s + (j.total_records_processed || 0), 0) || 0

  const overallSuccessRate = totalRuns > 0 ? ((totalSuccess / totalRuns) * 100).toFixed(1) : 'N/A'

  const worstJobs = (stats || [])
    .filter(j => j.success_rate < 100)
    .sort((a, b) => (a.success_rate || 0) - (b.success_rate || 0))
    .slice(0, 5)

  const statusEmoji = summary?.failedJobs === 0 ? '\u{1F7E2}' : summary?.failedJobs < 3 ? '\u{1F7E1}' : '\u{1F534}'

  let report = `<b>\u{1F4CA} Arena 每日报告</b>\n`
  report += `<i>${new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' })}</i>\n\n`
  report += `<b>状态:</b> ${statusEmoji} ${pipelineHealth.status}\n`
  report += `<b>成功率 (7天):</b> ${overallSuccessRate}%\n`
  report += `<b>总运行次数 (7天):</b> ${totalRuns}\n`
  report += `<b>处理记录数:</b> ${totalRecords.toLocaleString()}\n`
  report += `<b>错误数:</b> ${totalErrors}\n`
  report += `<b>任务:</b> ${summary?.healthyJobs || 0} 健康 / ${summary?.totalJobs || 0} 总计\n`

  if (worstJobs.length > 0) {
    report += `\n<b>成功率最低:</b>\n`
    for (const j of worstJobs) {
      report += `  ${j.success_rate}% - ${j.job_name}\n`
    }
  }

  if (summary?.staleJobs > 0 || summary?.stuckJobs > 0) {
    report += `\n\u{26A0}\u{FE0F} ${summary.staleJobs} 过期, ${summary.stuckJobs} 卡住`
  }

  await sendTelegram(report)
  console.log('每日报告已发送')
}

// ============================================
// 入口
// ============================================

const mode = process.argv[2] || 'check'

if (mode === 'daily') {
  runDailyReport().catch(err => {
    console.error('每日报告失败:', err)
    process.exit(1)
  })
} else {
  runHealthCheck().catch(err => {
    console.error('健康检查失败:', err)
    process.exit(1)
  })
}

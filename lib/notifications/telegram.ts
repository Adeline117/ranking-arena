/**
 * 统一 Telegram 告警模块
 *
 * 所有告警统一走这里，中文格式，内置限流。
 * 不依赖数据库配置，只用环境变量。
 */

import { logger } from '@/lib/logger'

// ============================================
// 类型
// ============================================

export type AlertLevel = 'critical' | 'warning' | 'info' | 'report'

export interface TelegramAlertOptions {
  level: AlertLevel
  source: string
  title: string
  message: string
  details?: Record<string, string | number>
}

// ============================================
// 限流
// ============================================

const rateLimitMap = new Map<string, number>()
const RATE_LIMIT_MS = 5 * 60 * 1000

function isRateLimited(key: string): boolean {
  const last = rateLimitMap.get(key) || 0
  if (Date.now() - last < RATE_LIMIT_MS) return true
  rateLimitMap.set(key, Date.now())
  for (const [k, t] of rateLimitMap) {
    if (Date.now() - t > RATE_LIMIT_MS * 2) rateLimitMap.delete(k)
  }
  return false
}

// ============================================
// 核心发送
// ============================================

const LEVEL_ICON: Record<AlertLevel, string> = {
  critical: '\u{1F534}',
  warning: '\u{1F7E1}',
  info: '\u{1F7E2}',
  report: '\u{1F4CA}',
}

const LEVEL_LABEL: Record<AlertLevel, string> = {
  critical: '严重',
  warning: '警告',
  info: '通知',
  report: '报告',
}

export async function sendTelegramAlert(opts: TelegramAlertOptions): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID
  if (!token || !chatId) {
    logger.warn('[Telegram] 未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID')
    return false
  }

  const rateKey = `${opts.level}:${opts.source}:${opts.title}`
  if (opts.level !== 'report' && isRateLimited(rateKey)) {
    logger.info(`[Telegram] 限流跳过: ${rateKey}`)
    return false
  }

  const icon = LEVEL_ICON[opts.level]
  const label = LEVEL_LABEL[opts.level]

  let text = `${icon}【${label}】${opts.source}\n\n`
  text += `<b>${opts.title}</b>\n`
  text += `${opts.message}\n`

  if (opts.details) {
    text += '\n'
    for (const [k, v] of Object.entries(opts.details)) {
      text += `  ${k}: ${v}\n`
    }
  }

  text += `\n<i>${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</i>`

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    if (!res.ok) {
      logger.error(`[Telegram] 发送失败: ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    logger.error('[Telegram] 发送异常:', err)
    return false
  }
}

// ============================================
// 每日摘要
// ============================================

export interface DailyDigestData {
  alertCount24h: number
  pipelineSuccessRate: number
  platformFreshness: Array<{ name: string; hoursAgo: number; status: 'ok' | 'stale' | 'critical' }>
  activeUsers?: number
  topErrors?: Array<{ job: string; count: number }>
}

export async function sendDailyDigest(data: DailyDigestData): Promise<boolean> {
  const statusIcon = data.pipelineSuccessRate >= 95 ? '\u{1F7E2}' :
                     data.pipelineSuccessRate >= 80 ? '\u{1F7E1}' : '\u{1F534}'

  let text = `\u{1F4CA} <b>Arena 每日报告</b>\n`
  text += `<i>${new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' })}</i>\n\n`
  text += `${statusIcon} Pipeline 成功率: ${data.pipelineSuccessRate.toFixed(1)}%\n`
  text += `告警数 (24h): ${data.alertCount24h}\n`
  if (data.activeUsers != null) text += `活跃用户: ${data.activeUsers}\n`

  const problems = data.platformFreshness.filter(p => p.status !== 'ok')
  if (problems.length > 0) {
    text += '\n<b>异常平台:</b>\n'
    for (const p of problems) {
      const pIcon = p.status === 'critical' ? '\u{1F534}' : '\u{1F7E1}'
      text += `  ${pIcon} ${p.name}: ${p.hoursAgo.toFixed(1)}h 前\n`
    }
  } else {
    text += '\n\u{2705} 所有平台数据正常\n'
  }

  if (data.topErrors?.length) {
    text += '\n<b>高频错误:</b>\n'
    for (const e of data.topErrors.slice(0, 5)) {
      text += `  ${e.job}: ${e.count} 次\n`
    }
  }

  return sendTelegramAlert({
    level: 'report',
    source: '每日摘要',
    title: 'Arena 每日报告',
    message: text,
  })
}

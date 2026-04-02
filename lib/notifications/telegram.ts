/**
 * 统一 Telegram 告警模块 (v2)
 *
 * All alerts go through this module. Features:
 * - 24-hour dedup via Redis (same platform + error type = 1 alert/24h)
 * - Severity-based routing:
 *   - CRITICAL → send immediately (with 24h dedup)
 *   - WARNING → buffer for daily digest only, don't send individually
 *   - INFO → log only, never send to Telegram
 *   - REPORT → always send (daily digest, weekly report)
 * - Recovery notifications when a platform returns to normal
 * - Daily digest function for cron scheduling
 */

import { logger } from '@/lib/logger'

// ============================================
// Types
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
// 24-hour Dedup via Redis
// ============================================

// Severity-based dedup windows
const DEDUP_TTL_BY_LEVEL: Record<AlertLevel, number> = {
  critical: 1 * 60 * 60,   // 1 hour  — don't miss repeated critical errors
  warning: 6 * 60 * 60,    // 6 hours
  info: 24 * 60 * 60,      // 24 hours (info is logged only, kept for completeness)
  report: 0,                // no dedup — always send
}

const DEDUP_TTL_SECONDS = 24 * 60 * 60 // 24 hours (legacy default)

/**
 * Check if this alert was already sent within the dedup window.
 * Uses Upstash Redis if available, falls back to in-memory Map.
 */
async function isDeduplicated(key: string, ttlSeconds: number = DEDUP_TTL_SECONDS): Promise<boolean> {
  // No dedup if TTL is 0 (e.g., report level)
  if (ttlSeconds <= 0) return false

  try {
    const { Redis } = await import('@upstash/redis')
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN
    if (url && token) {
      const redis = new Redis({ url, token })
      const existing = await redis.get<number>(`alert:dedup:${key}`)
      if (existing) return true
      await redis.set(`alert:dedup:${key}`, Date.now(), { ex: ttlSeconds })
      return false
    }
  } catch {
    // Intentionally swallowed: Redis unavailable for dedup, falling through to in-memory rate limit
  }

  // In-memory fallback (won't survive Vercel cold starts, but better than nothing)
  return isRateLimitedInMemory(key, ttlSeconds * 1000)
}

/**
 * Clear dedup state for a key (used for recovery notifications).
 */
async function clearDedup(key: string): Promise<void> {
  try {
    const { Redis } = await import('@upstash/redis')
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN
    if (url && token) {
      const redis = new Redis({ url, token })
      await redis.del(`alert:dedup:${key}`)
    }
  } catch {
    // Intentionally swallowed: Redis dedup clear is best-effort, in-memory always cleared below
  }
  inMemoryMap.delete(key)
}

// In-memory fallback
const inMemoryMap = new Map<string, number>()
const IN_MEMORY_TTL = 60 * 60 * 1000 // 1 hour (shorter than Redis, since it's unreliable across cold starts)

function isRateLimitedInMemory(key: string, ttlMs: number = IN_MEMORY_TTL): boolean {
  const last = inMemoryMap.get(key) || 0
  if (Date.now() - last < ttlMs) return true
  inMemoryMap.set(key, Date.now())
  // Cleanup old entries
  for (const [k, t] of inMemoryMap) {
    if (Date.now() - t > IN_MEMORY_TTL * 2) inMemoryMap.delete(k)
  }
  return false
}

// ============================================
// Core Sending
// ============================================

const LEVEL_ICON: Record<AlertLevel, string> = {
  critical: '\u{1F534}',  // 🔴
  warning: '\u{1F7E1}',   // 🟡
  info: '\u{1F7E2}',      // 🟢
  report: '\u{1F4CA}',    // 📊
}

const LEVEL_LABEL: Record<AlertLevel, string> = {
  critical: '严重',
  warning: '警告',
  info: '通知',
  report: '报告',
}

/**
 * Send a Telegram alert with severity-based routing and 24h dedup.
 *
 * - CRITICAL: sent immediately, deduped per platform+title for 24h
 * - WARNING: NOT sent individually — buffered for daily digest
 * - INFO: NOT sent — only logged
 * - REPORT: always sent (bypasses dedup)
 *
 * Returns true if the message was actually sent to Telegram.
 */
export async function sendTelegramAlert(opts: TelegramAlertOptions): Promise<boolean> {
  // INFO level: log only, never send
  if (opts.level === 'info') {
    logger.info(`[Telegram/INFO] ${opts.source}: ${opts.title} — ${opts.message}`)
    return false
  }

  // WARNING level: log and buffer for daily digest, don't send individually
  if (opts.level === 'warning') {
    logger.warn(`[Telegram/WARNING] ${opts.source}: ${opts.title} — ${opts.message}`)
    // Record to Redis for daily digest aggregation
    try {
      await recordWarningForDigest(opts)
    } catch {
      // Intentionally swallowed: warning digest recording is best-effort, individual alert still logged above
    }
    return false
  }

  // CRITICAL and REPORT: send to Telegram
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID
  if (!token || !chatId) {
    logger.warn('[Telegram] 未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID')
    return false
  }

  // Severity-based dedup: critical=1h, report=no dedup
  // Normalize title to prevent key explosion from dynamic error messages
  const dedupTtl = DEDUP_TTL_BY_LEVEL[opts.level]
  if (dedupTtl > 0) {
    // Strip numbers, hashes, timestamps from title to create stable dedup key
    const normalizedTitle = opts.title.replace(/[\d]+/g, 'N').replace(/[a-f0-9]{8,}/gi, 'HASH').slice(0, 80)
    const dedupKey = `${opts.source}:${normalizedTitle}`
    const deduped = await isDeduplicated(dedupKey, dedupTtl)
    if (deduped) {
      logger.info(`[Telegram] ${dedupTtl / 3600}h 去重跳过: ${dedupKey}`)
      return false
    }
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
// Recovery Notifications
// ============================================

/**
 * Send a recovery notification when a platform returns to normal.
 * Clears the dedup key so the next failure will trigger a new alert.
 */
export async function sendRecoveryNotification(
  platform: string,
  lastErrorType: string,
  downtimeMinutes: number
): Promise<boolean> {
  // Clear dedup so next failure triggers immediately
  await clearDedup(`${platform}:${lastErrorType}`)

  return sendTelegramAlert({
    level: 'report',
    source: platform,
    title: `✅ ${platform} recovered`,
    message: `Last error: ${lastErrorType}\nDowntime: ${downtimeMinutes < 60 ? `${downtimeMinutes}m` : `${(downtimeMinutes / 60).toFixed(1)}h`}`,
  })
}

// ============================================
// Warning Buffer for Daily Digest
// ============================================

/**
 * Record a WARNING alert to Redis for inclusion in daily digest.
 * Stored as a sorted set with timestamp scores for 24h retention.
 */
async function recordWarningForDigest(opts: TelegramAlertOptions): Promise<void> {
  try {
    const { Redis } = await import('@upstash/redis')
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN
    if (!url || !token) return

    const redis = new Redis({ url, token })
    const entry = JSON.stringify({
      source: opts.source,
      title: opts.title,
      message: opts.message.slice(0, 200),
      ts: Date.now(),
    })
    await redis.zadd('alert:warnings:24h', { score: Date.now(), member: entry })
    // Trim entries older than 24h + cap at 1000 entries max
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    await redis.zremrangebyscore('alert:warnings:24h', 0, cutoff)
    await redis.zremrangebyrank('alert:warnings:24h', 0, -1001)
  } catch {
    // Intentionally swallowed: Redis warning aggregation is best-effort, alerts still sent via primary channel
  }
}

/**
 * Get buffered warnings from Redis for the daily digest.
 */
async function getBufferedWarnings(): Promise<Array<{ source: string; title: string; message: string; ts: number }>> {
  try {
    const { Redis } = await import('@upstash/redis')
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN
    if (!url || !token) return []

    const redis = new Redis({ url, token })
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const entries = await redis.zrange('alert:warnings:24h', cutoff, Date.now(), { byScore: true })
    return (entries as string[]).map(e => {
      try { return JSON.parse(e) }
      catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

// ============================================
// Daily Digest (Enhanced)
// ============================================

export interface DailyDigestData {
  alertCount24h: number
  pipelineSuccessRate: number
  platformFreshness: Array<{ name: string; hoursAgo: number; status: 'ok' | 'stale' | 'critical' }>
  activeUsers?: number
  topErrors?: Array<{ job: string; count: number }>
  snapshotCount24h?: number
  snapshotCountYesterday?: number
  enrichmentCompletionRate?: number
}

export async function sendDailyDigest(data: DailyDigestData): Promise<boolean> {
  const statusIcon = data.pipelineSuccessRate >= 95 ? '\u{1F7E2}' :
                     data.pipelineSuccessRate >= 80 ? '\u{1F7E1}' : '\u{1F534}'

  // Count platforms by status
  const okCount = data.platformFreshness.filter(p => p.status === 'ok').length
  const totalCount = data.platformFreshness.length

  let text = `\u{1F4CA} <b>Arena 每日报告</b>\n`
  text += `<i>${new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' })}</i>\n\n`

  // Pipeline overview
  text += `${statusIcon} Pipeline 成功率: ${data.pipelineSuccessRate.toFixed(1)}%\n`
  text += `正常管道: ${okCount}/${totalCount}\n`
  text += `告警数 (24h): ${data.alertCount24h}\n`

  // Snapshot counts
  if (data.snapshotCount24h != null) {
    text += `新增 Snapshot: ${data.snapshotCount24h.toLocaleString()}`
    if (data.snapshotCountYesterday != null && data.snapshotCountYesterday > 0) {
      const change = ((data.snapshotCount24h - data.snapshotCountYesterday) / data.snapshotCountYesterday * 100).toFixed(1)
      text += ` (${Number(change) >= 0 ? '+' : ''}${change}% vs 昨天)`
    }
    text += '\n'
  }

  // Enrichment
  if (data.enrichmentCompletionRate != null) {
    text += `Enrichment 完成率: ${data.enrichmentCompletionRate.toFixed(1)}%\n`
  }

  if (data.activeUsers != null) text += `活跃用户: ${data.activeUsers}\n`

  // Problem platforms
  const criticals = data.platformFreshness.filter(p => p.status === 'critical')
  const stales = data.platformFreshness.filter(p => p.status === 'stale')

  if (criticals.length > 0) {
    text += '\n<b>\u{1F534} CRITICAL 管道:</b>\n'
    for (const p of criticals) {
      text += `  ${p.name}: ${p.hoursAgo.toFixed(1)}h 未更新\n`
    }
  }

  if (stales.length > 0) {
    text += '\n<b>\u{1F7E1} WARNING 管道:</b>\n'
    for (const p of stales) {
      text += `  ${p.name}: ${p.hoursAgo.toFixed(1)}h 未更新\n`
    }
  }

  if (criticals.length === 0 && stales.length === 0) {
    text += '\n\u{2705} 所有平台数据正常\n'
  }

  // Buffered warnings from past 24h
  const warnings = await getBufferedWarnings()
  if (warnings.length > 0) {
    // Group by source
    const bySource = new Map<string, number>()
    for (const w of warnings) {
      bySource.set(w.source, (bySource.get(w.source) || 0) + 1)
    }
    text += `\n<b>过去 24h 的 WARNING (${warnings.length} 条):</b>\n`
    for (const [source, count] of Array.from(bySource.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      text += `  ${source}: ${count} 次\n`
    }
  }

  // Top errors
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

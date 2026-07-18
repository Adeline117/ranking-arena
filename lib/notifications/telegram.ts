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
import { getSharedRedis } from '@/lib/cache/redis-client'

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

export type TelegramDeliveryResult =
  | { outcome: 'delivered'; httpStatus: number }
  | {
      outcome: 'suppressed'
      reason: 'deduplicated' | 'in_flight' | 'info_log_only' | 'warning_buffered'
    }
  | {
      outcome: 'failed'
      reason: 'missing_config' | 'http_error' | 'timeout' | 'network_error'
      httpStatus?: number
    }

// ============================================
// 24-hour Dedup via Redis
// ============================================

// Severity-based dedup windows
const DEDUP_TTL_BY_LEVEL: Record<AlertLevel, number> = {
  critical: 1 * 60 * 60, // 1 hour  — don't miss repeated critical errors
  warning: 6 * 60 * 60, // 6 hours
  info: 24 * 60 * 60, // 24 hours (info is logged only, kept for completeness)
  report: 0, // no dedup — always send
}

const DEDUP_TTL_SECONDS = 24 * 60 * 60 // 24 hours (legacy default)
const INFLIGHT_TTL_SECONDS = 30
const TELEGRAM_REQUEST_TIMEOUT_MS = 8_000

const ACQUIRE_DELIVERY_LEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 'deduplicated'
end
if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return 'acquired'
end
return 'in_flight'
`

const COMMIT_DELIVERY_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
if redis.call('GET', KEYS[2]) == ARGV[1] then
  redis.call('DEL', KEYS[2])
end
return 1
`

const RELEASE_DELIVERY_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

type AcquiredDeliveryLease = {
  state: 'acquired'
  markDelivered: () => Promise<void>
  release: () => Promise<void>
}

type DeliveryLease = { state: 'deduplicated' } | { state: 'in_flight' } | AcquiredDeliveryLease

const inMemoryDelivered = new Map<string, { deliveredAt: number; expiresAt: number }>()
const inMemoryInFlight = new Set<string>()

function pruneInMemoryDedup(now: number): void {
  for (const [key, value] of inMemoryDelivered) {
    if (value.expiresAt <= now) inMemoryDelivered.delete(key)
  }
}

function getInMemorySuppression(key: string, now: number): DeliveryLease | null {
  pruneInMemoryDedup(now)
  const delivered = inMemoryDelivered.get(key)
  if (delivered && delivered.expiresAt > now) return { state: 'deduplicated' }
  if (inMemoryInFlight.has(key)) return { state: 'in_flight' }
  return null
}

function acquireInMemoryLease(key: string, ttlSeconds: number): DeliveryLease {
  const now = Date.now()
  const suppression = getInMemorySuppression(key, now)
  if (suppression) return suppression

  inMemoryInFlight.add(key)
  return {
    state: 'acquired',
    markDelivered: async () => {
      const deliveredAt = Date.now()
      inMemoryDelivered.set(key, {
        deliveredAt,
        expiresAt: deliveredAt + ttlSeconds * 1000,
      })
    },
    release: async () => {
      inMemoryInFlight.delete(key)
    },
  }
}

/**
 * Acquire a short sending lease without claiming that delivery succeeded.
 * The durable dedup marker is committed only after Telegram confirms ok:true.
 */
async function acquireDeliveryLease(
  key: string,
  ttlSeconds: number = DEDUP_TTL_SECONDS
): Promise<DeliveryLease> {
  if (ttlSeconds <= 0) {
    return {
      state: 'acquired',
      markDelivered: async () => {},
      release: async () => {},
    }
  }

  const localSuppression = getInMemorySuppression(key, Date.now())
  if (localSuppression) return localSuppression

  try {
    const redis = await getSharedRedis()
    if (redis) {
      const dedupKey = `alert:dedup:${key}`
      const inflightKey = `alert:inflight:${key}`
      const leaseToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`
      const state = (await redis.eval(
        ACQUIRE_DELIVERY_LEASE_SCRIPT,
        [dedupKey, inflightKey],
        [leaseToken, INFLIGHT_TTL_SECONDS.toString()]
      )) as DeliveryLease['state']

      if (state === 'deduplicated' || state === 'in_flight') return { state }
      if (state !== 'acquired') {
        throw new Error('unexpected Redis lease response')
      }

      inMemoryInFlight.add(key)
      return {
        state: 'acquired',
        markDelivered: async () => {
          const deliveredAt = Date.now()
          inMemoryDelivered.set(key, {
            deliveredAt,
            expiresAt: deliveredAt + ttlSeconds * 1000,
          })
          try {
            await redis.eval(
              COMMIT_DELIVERY_SCRIPT,
              [dedupKey, inflightKey],
              [leaseToken, deliveredAt.toString(), ttlSeconds.toString()]
            )
          } catch (err) {
            logger.error(
              '[telegram] Redis delivery commit failed:',
              err instanceof Error ? err.name : 'UnknownError'
            )
          }
        },
        release: async () => {
          inMemoryInFlight.delete(key)
          try {
            await redis.eval(RELEASE_DELIVERY_LEASE_SCRIPT, [inflightKey], [leaseToken])
          } catch (err) {
            logger.error(
              '[telegram] Redis delivery lease release failed:',
              err instanceof Error ? err.name : 'UnknownError'
            )
          }
        },
      }
    }
  } catch (err) {
    logger.error(
      '[telegram] Redis delivery lease failed:',
      err instanceof Error ? err.name : 'UnknownError'
    )
  }

  return acquireInMemoryLease(key, ttlSeconds)
}

/**
 * Clear dedup state for a key (used for recovery notifications).
 */
async function clearDedup(key: string): Promise<void> {
  try {
    const redis = await getSharedRedis()
    if (redis) {
      await redis.del(`alert:dedup:${key}`, `alert:inflight:${key}`)
    }
  } catch (err) {
    logger.error(
      '[telegram] Redis dedup clear failed:',
      err instanceof Error ? err.name : 'UnknownError'
    )
  }
  inMemoryDelivered.delete(key)
  inMemoryInFlight.delete(key)
}

// ============================================
// Core Sending
// ============================================

const LEVEL_ICON: Record<AlertLevel, string> = {
  critical: '\u{1F534}', // 🔴
  warning: '\u{1F7E1}', // 🟡
  info: '\u{1F7E2}', // 🟢
  report: '\u{1F4CA}', // 📊
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
 * Returns a typed outcome so callers can distinguish expected suppression from
 * transport failure. The compatibility wrapper below remains boolean.
 */
export async function sendTelegramAlertDetailed(
  opts: TelegramAlertOptions
): Promise<TelegramDeliveryResult> {
  // INFO level: log only, never send
  if (opts.level === 'info') {
    logger.info(`[Telegram/INFO] ${opts.source}: ${opts.title} — ${opts.message}`)
    return { outcome: 'suppressed', reason: 'info_log_only' }
  }

  // WARNING level: log and buffer for daily digest, don't send individually
  if (opts.level === 'warning') {
    logger.warn(`[Telegram/WARNING] ${opts.source}: ${opts.title} — ${opts.message}`)
    // Record to Redis for daily digest aggregation
    try {
      await recordWarningForDigest(opts)
    } catch (err) {
      logger.error(
        '[telegram] warning digest recording failed:',
        err instanceof Error ? err.message : String(err)
      )
    }
    return { outcome: 'suppressed', reason: 'warning_buffered' }
  }

  // CRITICAL and REPORT: send to Telegram
  const token = process.env.TELEGRAM_BOT_TOKEN
  // P0/FYI 分层(2026-07-11):critical 走独立 chat(可静音例外),其余进 FYI chat。
  // TELEGRAM_CRITICAL_CHAT_ID 未设则回退到 ALERT_CHAT_ID(零行为变化)。
  const fyiChatId = process.env.TELEGRAM_ALERT_CHAT_ID
  const chatId =
    opts.level === 'critical' ? process.env.TELEGRAM_CRITICAL_CHAT_ID || fyiChatId : fyiChatId
  if (!token || !chatId) {
    logger.warn('[Telegram] 未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID')
    return { outcome: 'failed', reason: 'missing_config' }
  }

  // Severity-based dedup: critical=1h, report=no dedup
  // Normalize title to prevent key explosion from dynamic error messages
  const dedupTtl = DEDUP_TTL_BY_LEVEL[opts.level]
  let lease: AcquiredDeliveryLease = {
    state: 'acquired',
    markDelivered: async () => {},
    release: async () => {},
  }
  if (dedupTtl > 0) {
    // Strip numbers, hashes, timestamps from title to create stable dedup key
    const normalizedTitle = opts.title
      .replace(/[\d]+/g, 'N')
      .replace(/[a-f0-9]{8,}/gi, 'HASH')
      .slice(0, 80)
    const dedupKey = `${opts.source}:${normalizedTitle}`
    const candidateLease = await acquireDeliveryLease(dedupKey, dedupTtl)
    if (candidateLease.state === 'deduplicated') {
      logger.info(`[Telegram] ${dedupTtl / 3600}h 去重跳过: ${dedupKey}`)
      return { outcome: 'suppressed', reason: 'deduplicated' }
    }
    if (candidateLease.state === 'in_flight') {
      logger.info(`[Telegram] 发送进行中，跳过重复请求: ${dedupKey}`)
      return { outcome: 'suppressed', reason: 'in_flight' }
    }
    lease = candidateLease
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
      signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    })
    const responseBody = await res.json().catch(() => null)
    const telegramAccepted =
      !!responseBody &&
      typeof responseBody === 'object' &&
      'ok' in responseBody &&
      responseBody.ok === true
    if (!res.ok || !telegramAccepted) {
      logger.error(`[Telegram] 发送失败: ${res.status}`)
      return { outcome: 'failed', reason: 'http_error', httpStatus: res.status }
    }
    await lease.markDelivered()
    return { outcome: 'delivered', httpStatus: res.status }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    logger.error(
      `[Telegram] ${isTimeout ? '发送超时' : '发送异常'}:`,
      err instanceof Error ? err.name : 'UnknownError'
    )
    return { outcome: 'failed', reason: isTimeout ? 'timeout' : 'network_error' }
  } finally {
    await lease.release()
  }
}

/**
 * Backward-compatible boolean API. Only a confirmed Telegram delivery is true.
 */
export async function sendTelegramAlert(opts: TelegramAlertOptions): Promise<boolean> {
  const result = await sendTelegramAlertDetailed(opts)
  return result.outcome === 'delivered'
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
    const redis = await getSharedRedis()
    if (!redis) return

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
  } catch (err) {
    logger.error(
      '[telegram] Redis warning aggregation failed:',
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * Get buffered warnings from Redis for the daily digest.
 */
async function getBufferedWarnings(): Promise<
  Array<{ source: string; title: string; message: string; ts: number }>
> {
  try {
    const redis = await getSharedRedis()
    if (!redis) return []

    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const entries = await redis.zrange('alert:warnings:24h', cutoff, Date.now(), { byScore: true })
    return (entries as string[])
      .map((e) => {
        try {
          return JSON.parse(e)
        } catch (_err) {
          return null
        }
      })
      .filter(Boolean)
  } catch (err) {
    logger.error(
      '[telegram] getBufferedWarnings failed:',
      err instanceof Error ? err.message : String(err)
    )
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
  const statusIcon =
    data.pipelineSuccessRate >= 95
      ? '\u{1F7E2}'
      : data.pipelineSuccessRate >= 80
        ? '\u{1F7E1}'
        : '\u{1F534}'

  // Count platforms by status
  const okCount = data.platformFreshness.filter((p) => p.status === 'ok').length
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
      const change = (
        ((data.snapshotCount24h - data.snapshotCountYesterday) / data.snapshotCountYesterday) *
        100
      ).toFixed(1)
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
  const criticals = data.platformFreshness.filter((p) => p.status === 'critical')
  const stales = data.platformFreshness.filter((p) => p.status === 'stale')

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
    for (const [source, count] of Array.from(bySource.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)) {
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

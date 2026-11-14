/**
 * 告警发送 - 多渠道支持 (Novu 38.7K★ 启发)
 *
 * 默认走 Telegram。支持扩展到 Slack、Email 等渠道。
 * 保留 sendAlert / sendScraperAlert / sendSmartAlert 等接口向后兼容。
 */

import { sendTelegramAlertDetailed, type AlertLevel } from '@/lib/notifications/telegram'
import { logger } from '@/lib/logger'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { postGithubIssueAlert } from '@/lib/alerts/github-issue'

interface AlertPayload {
  source?: string
  title: string
  message: string
  level: 'info' | 'warning' | 'critical'
  details?: Record<string, unknown>
  /** Override default channels. Default: ['telegram'] */
  channels?: AlertChannel[]
}

type AlertChannel = 'telegram' | 'slack' | 'email' | 'webhook'

interface ChannelDelivery {
  delivered: boolean
  handled: boolean
}

interface AlertDispatchResult {
  sent: boolean
  channels: string[]
  requestedChannelDelivered: boolean
}

/** SEV1 backup channel — GitHub Issue (lib/alerts/github-issue.ts). */
async function sendGithubIssueAlert(payload: AlertPayload): Promise<boolean> {
  const isCritical = payload.level === 'critical'
  const title = isCritical ? `🛑 [SEV1] ${payload.title}` : `⚠️ [WARN] ${payload.title}`
  const detailLines = payload.details
    ? Object.entries(payload.details).map(([k, v]) => `- **${k}**: ${String(v)}`)
    : []
  const body = [
    payload.message,
    '',
    ...detailLines,
    '',
    isCritical
      ? `_Telegram 主通道发送失败，GitHub issue 兜底（SEV1 备份通道）。_`
      : `_Telegram 主通道发送失败，warning 级 GitHub issue 兜底（同标题 6h 内只发一次）。_`,
    new Date().toISOString(),
  ].join('\n')
  return postGithubIssueAlert(title, body)
}

// ============================================
// 主通道失败兜底(warning 也不能消失,2026-11 audit P2-9)
// ============================================

/** Every alert whose primary channel failed, any level, newest first. Read
 *  out-of-band (no Telegram needed); bounded so it cannot grow forever. */
export const UNDELIVERED_ALERTS_KEY = 'alert:undelivered'
const UNDELIVERED_ALERTS_MAX = 500
/** Same-title warning fallbacks open/comment a GitHub issue at most once per window. */
const WARNING_FALLBACK_DEDUP_MS = 6 * 3600_000
const warningFallbackMemo: Map<string, number> = new Map()

function titleHash(title: string): string {
  let h = 5381
  for (let i = 0; i < title.length; i++) h = ((h << 5) + h + title.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

async function recordUndeliveredAlert(payload: AlertPayload, reason: string): Promise<void> {
  try {
    const redis = await getSharedRedis()
    if (!redis) return
    await redis.lpush(
      UNDELIVERED_ALERTS_KEY,
      JSON.stringify({
        level: payload.level,
        title: payload.title.slice(0, 200),
        message: payload.message.slice(0, 500),
        reason,
        at: new Date().toISOString(),
      })
    )
    await redis.ltrim(UNDELIVERED_ALERTS_KEY, 0, UNDELIVERED_ALERTS_MAX - 1)
  } catch (err) {
    logger.error(
      '[send-alert] could not persist undelivered alert:',
      err instanceof Error ? err.message : String(err)
    )
  }
}

/** Claim the per-title warning fallback window (Redis SET NX; in-memory when
 *  Redis is unavailable). Returns false when this title already fell back. */
async function claimWarningFallback(title: string): Promise<boolean> {
  const key = `alert:fallback:warning:${titleHash(title)}`
  try {
    const redis = await getSharedRedis()
    if (redis) {
      const res = await redis.set(key, Date.now(), {
        nx: true,
        px: WARNING_FALLBACK_DEDUP_MS,
      })
      return res === 'OK'
    }
  } catch (err) {
    logger.error(
      '[send-alert] warning fallback dedup read failed; using local memo:',
      err instanceof Error ? err.message : String(err)
    )
  }
  const now = Date.now()
  const last = warningFallbackMemo.get(key)
  if (last && now - last < WARNING_FALLBACK_DEDUP_MS) return false
  warningFallbackMemo.set(key, now)
  return true
}

/** Channel registry — add new channels here (Novu-inspired) */
const CHANNEL_HANDLERS: Record<AlertChannel, (payload: AlertPayload) => Promise<ChannelDelivery>> =
  {
    telegram: async (payload) => {
      const result = await sendTelegramAlertDetailed({
        level: payload.level as AlertLevel,
        source: payload.source ?? '系统告警',
        title: payload.title,
        message: payload.message,
        details: payload.details
          ? Object.fromEntries(Object.entries(payload.details).map(([k, v]) => [k, String(v)]))
          : undefined,
      })
      return {
        delivered: result.outcome === 'delivered',
        handled: result.outcome !== 'failed',
      }
    },
    slack: async (_payload) => {
      // Stub: Slack webhook integration not yet configured
      return { delivered: false, handled: false }
    },
    email: async (_payload) => {
      // Stub: email integration not yet configured (planned: Resend)
      return { delivered: false, handled: false }
    },
    webhook: async (payload) => {
      const url = process.env.ALERT_WEBHOOK_URL
      if (!url) return { delivered: false, handled: false }
      // Retry with exponential backoff (svix 3.1K★ pattern)
      const maxRetries = 3
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, attempt, timestamp: new Date().toISOString() }),
            signal: AbortSignal.timeout(5000),
          })
          if (res.ok) return { delivered: true, handled: true }
          if (res.status >= 400 && res.status < 500) {
            return { delivered: false, handled: false }
          }
        } catch (err) {
          logger.error(
            '[send-alert] webhook request failed:',
            err instanceof Error ? err.message : String(err)
          )
        }
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt))) // 1s, 2s, 4s
        }
      }
      return { delivered: false, handled: false }
    },
  }

// ============================================
// 核心发送 — 多渠道并发
// ============================================

async function dispatchAlert(payload: AlertPayload): Promise<AlertDispatchResult> {
  const channels = payload.channels || ['telegram']
  const sentChannels: string[] = []

  // Send to all channels in parallel (Novu pattern)
  const results = await Promise.allSettled(
    channels.map(async (channel) => {
      const handler = CHANNEL_HANDLERS[channel]
      if (!handler) {
        return { channel, delivery: { delivered: false, handled: false } }
      }
      try {
        const delivery = await handler(payload)
        return { channel, delivery }
      } catch (err) {
        logger.warn(`[Alert] Channel ${channel} failed:`, err)
        return { channel, delivery: { delivered: false, handled: false } }
      }
    })
  )

  const fulfilled = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  )
  for (const result of fulfilled) {
    if (result.delivery.delivered) sentChannels.push(result.channel)
  }
  const requestedChannelDelivered = fulfilled.some((result) => result.delivery.delivered)
  const telegramResult = fulfilled.find((result) => result.channel === 'telegram')

  // SEV1 backstop: Telegram is the only real primary channel and it's a SPOF
  // (a 401-broken token silently swallowed 28 deploys' worth of alerts). For
  // critical alerts, use the independent GitHub channel only for a real
  // Telegram failure. Expected dedup/in-flight suppression is already handled.
  //
  // Warning alerts get the same independent channel (audit P2-9: data gaps,
  // meta-monitor and disk warnings vanished whenever Telegram was 401),
  // de-duplicated per title for 6h so a noisy warning cannot spam issues.
  // Every real primary failure, any level, is also persisted to Redis.
  if (telegramResult && !telegramResult.delivery.handled) {
    await recordUndeliveredAlert(payload, 'telegram_failed')
    const fallback =
      payload.level === 'critical' ||
      (payload.level === 'warning' && (await claimWarningFallback(payload.title)))
    if (fallback) {
      try {
        const ghSent = await sendGithubIssueAlert(payload)
        if (ghSent) sentChannels.push('github')
      } catch (err) {
        logger.warn('[Alert] GitHub issue backup channel failed:', err)
      }
    }
  }

  return {
    sent: requestedChannelDelivered || sentChannels.includes('github'),
    channels: sentChannels,
    requestedChannelDelivered,
  }
}

export async function sendAlert(
  payload: AlertPayload
): Promise<{ sent: boolean; channels: string[] }> {
  const result = await dispatchAlert(payload)
  return { sent: result.sent, channels: result.channels }
}

// ============================================
// 爬虫告警
// ============================================

export async function sendScraperAlert(
  criticalPlatforms: string[],
  stalePlatforms: string[],
  platformNames: Record<string, string>
) {
  if (criticalPlatforms.length === 0 && stalePlatforms.length === 0) {
    return { sent: false, channels: [] }
  }

  const isCritical = criticalPlatforms.length > 0
  const level = isCritical ? 'critical' : 'warning'

  const criticalList = criticalPlatforms.map((p) => platformNames[p] || p).join(', ')
  const staleList = stalePlatforms.map((p) => platformNames[p] || p).join(', ')

  let message = ''
  if (criticalPlatforms.length > 0) {
    message += `严重过期 (>24h): ${criticalList}\n`
  }
  if (stalePlatforms.length > 0) {
    message += `数据陈旧 (>12h): ${staleList}`
  }

  return sendAlert({
    title: isCritical ? '爬虫数据严重过期告警' : '爬虫数据陈旧告警',
    message: message.trim(),
    level,
    details: {
      严重过期平台数: criticalPlatforms.length,
      陈旧平台数: stalePlatforms.length,
      检查时间: new Date().toLocaleString('zh-CN'),
    },
  })
}

// ============================================
// 智能告警聚合
// ============================================

interface AggregatedAlert {
  key: string
  count: number
  firstSeen: number
  lastSeen: number
  payload: AlertPayload
}

const alertBuffer: Map<string, AggregatedAlert> = new Map()
let flushTimer: ReturnType<typeof setTimeout> | null = null

const FLUSH_INTERVAL = 60000
const MIN_AGGREGATE_COUNT = 3

export async function sendSmartAlert(payload: AlertPayload, aggregateKey?: string): Promise<void> {
  const key = aggregateKey || `${payload.level}:${payload.title}`

  const existing = alertBuffer.get(key)
  if (existing) {
    existing.count++
    existing.lastSeen = Date.now()
    existing.payload = payload
  } else {
    alertBuffer.set(key, {
      key,
      count: 1,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      payload,
    })
  }

  if (!flushTimer) {
    flushTimer = setTimeout(flushAlertBuffer, FLUSH_INTERVAL)
  }
}

async function flushAlertBuffer(): Promise<void> {
  flushTimer = null

  const now = Date.now()
  const toSend: AggregatedAlert[] = []

  for (const [key, alert] of alertBuffer.entries()) {
    if (alert.count >= MIN_AGGREGATE_COUNT || now - alert.firstSeen >= FLUSH_INTERVAL) {
      toSend.push(alert)
      alertBuffer.delete(key)
    }
  }

  for (const alert of toSend) {
    const aggregatedPayload: AlertPayload = {
      ...alert.payload,
      title: alert.count > 1 ? `${alert.payload.title} (x${alert.count})` : alert.payload.title,
      details: {
        ...alert.payload.details,
        聚合数量: alert.count,
        首次发生: new Date(alert.firstSeen).toLocaleString('zh-CN'),
        最后发生: new Date(alert.lastSeen).toLocaleString('zh-CN'),
      },
    }
    await sendAlert(aggregatedPayload)
  }

  if (alertBuffer.size > 0 && !flushTimer) {
    flushTimer = setTimeout(flushAlertBuffer, FLUSH_INTERVAL)
  }
}

export async function flushAllAlerts(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  for (const [, alert] of alertBuffer.entries()) {
    const aggregatedPayload: AlertPayload = {
      ...alert.payload,
      title: alert.count > 1 ? `${alert.payload.title} (x${alert.count})` : alert.payload.title,
    }
    await sendAlert(aggregatedPayload)
  }
  alertBuffer.clear()
}

// ============================================
// 限流告警
// ============================================

// In-memory fallback only — Redis is preferred for cross-instance dedup
const rateLimitCache: Map<string, number> = new Map()

/** Default cooldowns by alert level. Critical alerts use 15min instead of 1h. */
const COOLDOWN_BY_LEVEL: Record<AlertPayload['level'], number> = {
  info: 3600000, // 1 hour
  warning: 3600000, // 1 hour
  critical: 900000, // 15 minutes
}

/**
 * Rate-limited alert sending.
 * Uses Redis for rate limiting (survives Vercel cold starts),
 * falls back to in-memory Map.
 *
 * If rateLimitMs is not provided, defaults based on payload.level:
 *   critical = 15min, warning/info = 1h.
 */
export async function sendRateLimitedAlert(
  payload: AlertPayload,
  rateLimitKey: string,
  rateLimitMs?: number
): Promise<{ sent: boolean; rateLimited: boolean; channels: string[] }> {
  const now = Date.now()
  const effectiveCooldown = rateLimitMs ?? COOLDOWN_BY_LEVEL[payload.level] ?? 300000
  const redisKey = `alert:ratelimit:${rateLimitKey}`
  let redis: Awaited<ReturnType<typeof getSharedRedis>> = null

  // Read the shared cooldown first. A read failure falls back to the local gate.
  try {
    redis = await getSharedRedis()
    if (redis) {
      const existing = await redis.get<number>(redisKey)
      if (existing && now - existing < effectiveCooldown) {
        return { sent: false, rateLimited: true, channels: [] }
      }
    }
  } catch (err) {
    logger.error(
      '[send-alert] Redis rate limit read failed:',
      err instanceof Error ? err.message : String(err)
    )
    redis = null
  }

  // Also honor a local marker left by a prior Redis read/write outage.
  const lastSent = rateLimitCache.get(rateLimitKey)
  if (lastSent && now - lastSent < effectiveCooldown) {
    return { sent: false, rateLimited: true, channels: [] }
  }

  // Dispatch exactly once. A post-delivery cooldown write failure must never
  // fall through and send the alert a second time.
  const result = await dispatchAlert(payload)

  if (result.requestedChannelDelivered) {
    let storedInRedis = false
    if (redis) {
      try {
        await redis.set(redisKey, now, { ex: Math.ceil(effectiveCooldown / 1000) })
        storedInRedis = true
      } catch (err) {
        logger.error(
          '[send-alert] Redis rate limit write failed:',
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    if (!storedInRedis) rateLimitCache.set(rateLimitKey, now)
    for (const [key, time] of rateLimitCache.entries()) {
      if (now - time > effectiveCooldown * 2) {
        rateLimitCache.delete(key)
      }
    }
  }

  return { sent: result.sent, channels: result.channels, rateLimited: false }
}

// ============================================
// 批量执行摘要
// ============================================

export interface ScrapeBatchSummary {
  totalPlatforms: number
  successPlatforms: number
  failedPlatforms: string[]
  totalDuration: number
  platformResults: Array<{
    platform: string
    success: boolean
    duration: number
    traderCount?: number
    error?: string
  }>
}

export async function sendScrapeBatchSummary(summary: ScrapeBatchSummary): Promise<void> {
  const { totalPlatforms, successPlatforms, failedPlatforms, totalDuration, platformResults } =
    summary

  const failureRate = failedPlatforms.length / totalPlatforms
  const level: AlertPayload['level'] =
    failureRate > 0.3 ? 'critical' : failureRate > 0.1 ? 'warning' : 'info'

  if (level === 'info' && failedPlatforms.length === 0) {
    return
  }

  const failedDetails = platformResults
    .filter((r) => !r.success)
    .map((r) => `${r.platform}: ${r.error?.substring(0, 50) || '未知错误'}`)
    .join('\n')

  await sendAlert({
    title: `抓取批量执行${level === 'critical' ? '严重失败' : level === 'warning' ? '部分失败' : '完成'}`,
    message: `成功: ${successPlatforms}/${totalPlatforms} 平台\n耗时: ${Math.round(totalDuration / 1000)}s\n\n${failedDetails || '无失败'}`,
    level,
    details: {
      成功率: `${((successPlatforms / totalPlatforms) * 100).toFixed(1)}%`,
      失败平台: failedPlatforms.join(', ') || '无',
      总耗时: `${Math.round(totalDuration / 1000)}s`,
    },
  })
}

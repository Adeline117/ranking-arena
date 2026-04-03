/**
 * 告警发送 - 多渠道支持 (Novu 38.7K★ 启发)
 *
 * 默认走 Telegram。支持扩展到 Slack、Email 等渠道。
 * 保留 sendAlert / sendScraperAlert / sendSmartAlert 等接口向后兼容。
 */

import { sendTelegramAlert, type AlertLevel } from '@/lib/notifications/telegram'
import { logger } from '@/lib/logger'
import { getSharedRedis } from '@/lib/cache/redis-client'

interface AlertPayload {
  title: string
  message: string
  level: 'info' | 'warning' | 'critical'
  details?: Record<string, unknown>
  /** Override default channels. Default: ['telegram'] */
  channels?: AlertChannel[]
}

type AlertChannel = 'telegram' | 'slack' | 'email' | 'webhook'

/** Channel registry — add new channels here (Novu-inspired) */
const CHANNEL_HANDLERS: Record<AlertChannel, (payload: AlertPayload) => Promise<boolean>> = {
  telegram: async (payload) => {
    return sendTelegramAlert({
      level: payload.level as AlertLevel,
      source: '系统告警',
      title: payload.title,
      message: payload.message,
      details: payload.details ? Object.fromEntries(
        Object.entries(payload.details).map(([k, v]) => [k, String(v)])
      ) : undefined,
    })
  },
  slack: async (_payload) => {
    // Stub: Slack webhook integration not yet configured
    return false
  },
  email: async (_payload) => {
    // Stub: email integration not yet configured (planned: Resend)
    return false
  },
  webhook: async (payload) => {
    const url = process.env.ALERT_WEBHOOK_URL
    if (!url) return false
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
        if (res.ok) return true
        if (res.status >= 400 && res.status < 500) return false // Don't retry 4xx
      } catch {
        // Retry on network errors
      }
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt))) // 1s, 2s, 4s
      }
    }
    return false
  },
}

// ============================================
// 核心发送 — 多渠道并发
// ============================================

export async function sendAlert(payload: AlertPayload): Promise<{ sent: boolean; channels: string[] }> {
  const channels = payload.channels || ['telegram']
  const sentChannels: string[] = []

  // Send to all channels in parallel (Novu pattern)
  const results = await Promise.allSettled(
    channels.map(async (channel) => {
      const handler = CHANNEL_HANDLERS[channel]
      if (!handler) return false
      try {
        const success = await handler(payload)
        if (success) sentChannels.push(channel)
        return success
      } catch (err) {
        logger.warn(`[Alert] Channel ${channel} failed:`, err)
        return false
      }
    })
  )

  const anySent = results.some(r => r.status === 'fulfilled' && r.value)
  return { sent: anySent, channels: sentChannels }
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

  const criticalList = criticalPlatforms.map(p => platformNames[p] || p).join(', ')
  const staleList = stalePlatforms.map(p => platformNames[p] || p).join(', ')

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
      '严重过期平台数': criticalPlatforms.length,
      '陈旧平台数': stalePlatforms.length,
      '检查时间': new Date().toLocaleString('zh-CN'),
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

export async function sendSmartAlert(
  payload: AlertPayload,
  aggregateKey?: string
): Promise<void> {
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
      title: alert.count > 1
        ? `${alert.payload.title} (x${alert.count})`
        : alert.payload.title,
      details: {
        ...alert.payload.details,
        '聚合数量': alert.count,
        '首次发生': new Date(alert.firstSeen).toLocaleString('zh-CN'),
        '最后发生': new Date(alert.lastSeen).toLocaleString('zh-CN'),
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
      title: alert.count > 1
        ? `${alert.payload.title} (x${alert.count})`
        : alert.payload.title,
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

/**
 * Rate-limited alert sending.
 * Uses Redis for rate limiting (survives Vercel cold starts),
 * falls back to in-memory Map.
 */
export async function sendRateLimitedAlert(
  payload: AlertPayload,
  rateLimitKey: string,
  rateLimitMs: number = 300000
): Promise<{ sent: boolean; rateLimited: boolean; channels: string[] }> {
  const now = Date.now()

  // Try Redis first (survives cold starts)
  try {
    const redis = await getSharedRedis()
    if (redis) {
      const redisKey = `alert:ratelimit:${rateLimitKey}`
      const existing = await redis.get<number>(redisKey)
      if (existing && now - existing < rateLimitMs) {
        return { sent: false, rateLimited: true, channels: [] }
      }
      const result = await sendAlert(payload)
      if (result.sent) {
        await redis.set(redisKey, now, { ex: Math.ceil(rateLimitMs / 1000) })
      }
      return { ...result, rateLimited: false }
    }
  } catch {
    // Redis unavailable — fall through to in-memory
  }

  // In-memory fallback
  const lastSent = rateLimitCache.get(rateLimitKey)
  if (lastSent && now - lastSent < rateLimitMs) {
    return { sent: false, rateLimited: true, channels: [] }
  }

  const result = await sendAlert(payload)

  if (result.sent) {
    rateLimitCache.set(rateLimitKey, now)
    for (const [key, time] of rateLimitCache.entries()) {
      if (now - time > rateLimitMs * 2) {
        rateLimitCache.delete(key)
      }
    }
  }

  return { ...result, rateLimited: false }
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
  const { totalPlatforms, successPlatforms, failedPlatforms, totalDuration, platformResults } = summary

  const failureRate = failedPlatforms.length / totalPlatforms
  const level: AlertPayload['level'] = failureRate > 0.3 ? 'critical' : failureRate > 0.1 ? 'warning' : 'info'

  if (level === 'info' && failedPlatforms.length === 0) {
    return
  }

  const failedDetails = platformResults
    .filter(r => !r.success)
    .map(r => `${r.platform}: ${r.error?.substring(0, 50) || '未知错误'}`)
    .join('\n')

  await sendAlert({
    title: `抓取批量执行${level === 'critical' ? '严重失败' : level === 'warning' ? '部分失败' : '完成'}`,
    message: `成功: ${successPlatforms}/${totalPlatforms} 平台\n耗时: ${Math.round(totalDuration / 1000)}s\n\n${failedDetails || '无失败'}`,
    level,
    details: {
      '成功率': `${((successPlatforms / totalPlatforms) * 100).toFixed(1)}%`,
      '失败平台': failedPlatforms.join(', ') || '无',
      '总耗时': `${Math.round(totalDuration / 1000)}s`,
    },
  })
}

/**
 * 发送报警通知
 * 支持 Slack、飞书 Webhook 和邮件
 */

import { createClient } from '@supabase/supabase-js'

interface AlertPayload {
  title: string
  message: string
  level: 'info' | 'warning' | 'critical'
  details?: Record<string, any>
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!url || !key) {
    return null
  }
  
  return createClient(url, key, { auth: { persistSession: false } })
}

async function getAlertConfig() {
  const supabase = getSupabaseAdmin()
  if (!supabase) return null
  
  const { data } = await supabase
    .from('alert_config')
    .select('key, value, enabled')
  
  if (!data) return null
  
  const config: Record<string, { value: string | null; enabled: boolean }> = {}
  for (const item of data) {
    config[item.key] = { value: item.value, enabled: item.enabled }
  }
  
  return config
}

async function sendSlackAlert(webhookUrl: string, payload: AlertPayload) {
  const colorMap = {
    info: '#36a64f',
    warning: '#ffcc00',
    critical: '#ff0000',
  }
  
  const slackPayload = {
    attachments: [{
      color: colorMap[payload.level],
      title: payload.title,
      text: payload.message,
      fields: payload.details ? Object.entries(payload.details).map(([key, value]) => ({
        title: key,
        value: String(value),
        short: true,
      })) : [],
      ts: Math.floor(Date.now() / 1000),
    }],
  }
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    })
    
    if (!response.ok) {
      console.error('[Alert] Slack webhook failed:', response.status)
      return false
    }
    return true
  } catch (error) {
    console.error('[Alert] Slack webhook error:', error)
    return false
  }
}

async function sendFeishuAlert(webhookUrl: string, payload: AlertPayload) {
  const colorMap = {
    info: 'green',
    warning: 'yellow',
    critical: 'red',
  }
  
  const feishuPayload = {
    msg_type: 'interactive',
    card: {
      header: {
        title: {
          tag: 'plain_text',
          content: payload.title,
        },
        template: colorMap[payload.level],
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: payload.message,
          },
        },
        ...(payload.details ? [{
          tag: 'div',
          fields: Object.entries(payload.details).map(([key, value]) => ({
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**${key}:** ${value}`,
            },
          })),
        }] : []),
      ],
    },
  }
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feishuPayload),
    })
    
    if (!response.ok) {
      console.error('[Alert] Feishu webhook failed:', response.status)
      return false
    }
    return true
  } catch (error) {
    console.error('[Alert] Feishu webhook error:', error)
    return false
  }
}

async function sendEmailAlert(toEmail: string, payload: AlertPayload) {
  const resendApiKey = process.env.RESEND_API_KEY
  if (!resendApiKey) {
    console.error('[Alert] RESEND_API_KEY not configured')
    return false
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'alerts@ranking-arena.com'

  const levelEmoji = {
    info: 'ℹ️',
    warning: '⚠️',
    critical: '🚨',
  }

  const detailsHtml = payload.details
    ? `<table style="border-collapse: collapse; margin-top: 16px;">
        ${Object.entries(payload.details)
          .map(
            ([key, value]) =>
              `<tr>
                <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">${key}</td>
                <td style="padding: 8px; border: 1px solid #ddd;">${value}</td>
              </tr>`
          )
          .join('')}
      </table>`
    : ''

  const emailPayload = {
    from: fromEmail,
    to: [toEmail],
    subject: `${levelEmoji[payload.level]} ${payload.title}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: ${payload.level === 'critical' ? '#dc2626' : payload.level === 'warning' ? '#ca8a04' : '#16a34a'};">
          ${levelEmoji[payload.level]} ${payload.title}
        </h2>
        <p style="color: #374151; font-size: 16px; line-height: 1.6;">
          ${payload.message.replace(/\n/g, '<br>')}
        </p>
        ${detailsHtml}
        <hr style="margin-top: 24px; border: none; border-top: 1px solid #e5e7eb;">
        <p style="color: #6b7280; font-size: 12px;">
          此邮件由 Ranking Arena 报警系统自动发送
        </p>
      </div>
    `,
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify(emailPayload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Alert] Email send failed:', response.status, errorText)
      return false
    }
    return true
  } catch (error) {
    console.error('[Alert] Email send error:', error)
    return false
  }
}

export async function sendAlert(payload: AlertPayload): Promise<{ sent: boolean; channels: string[] }> {
  const config = await getAlertConfig()
  if (!config) {
    console.log('[Alert] No config found, skipping alerts')
    return { sent: false, channels: [] }
  }
  
  const sentChannels: string[] = []
  
  // Send to Slack
  if (config.slack_webhook_url?.enabled && config.slack_webhook_url?.value) {
    const success = await sendSlackAlert(config.slack_webhook_url.value, payload)
    if (success) sentChannels.push('slack')
  }
  
  // Send to Feishu
  if (config.feishu_webhook_url?.enabled && config.feishu_webhook_url?.value) {
    const success = await sendFeishuAlert(config.feishu_webhook_url.value, payload)
    if (success) sentChannels.push('feishu')
  }
  
  // Send email via Resend
  if (config.alert_email?.enabled && config.alert_email?.value) {
    const success = await sendEmailAlert(config.alert_email.value, payload)
    if (success) sentChannels.push('email')
  }
  
  return {
    sent: sentChannels.length > 0,
    channels: sentChannels,
  }
}

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

const FLUSH_INTERVAL = 60000 // 1 分钟聚合窗口
const MIN_AGGREGATE_COUNT = 3 // 最少聚合数量才发送

/**
 * 智能告警 - 自动聚合相似告警
 */
export async function sendSmartAlert(
  payload: AlertPayload,
  aggregateKey?: string
): Promise<void> {
  const key = aggregateKey || `${payload.level}:${payload.title}`

  const existing = alertBuffer.get(key)
  if (existing) {
    existing.count++
    existing.lastSeen = Date.now()
    existing.payload = payload // 更新为最新内容
  } else {
    alertBuffer.set(key, {
      key,
      count: 1,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      payload,
    })
  }

  // 启动定时刷新
  if (!flushTimer) {
    flushTimer = setTimeout(flushAlertBuffer, FLUSH_INTERVAL)
  }
}

/**
 * 刷新告警缓冲区
 */
async function flushAlertBuffer(): Promise<void> {
  flushTimer = null

  const now = Date.now()
  const toSend: AggregatedAlert[] = []

  for (const [key, alert] of alertBuffer.entries()) {
    // 只发送聚合后的告警，或者超过时间窗口的单个告警
    if (alert.count >= MIN_AGGREGATE_COUNT || now - alert.firstSeen >= FLUSH_INTERVAL) {
      toSend.push(alert)
      alertBuffer.delete(key)
    }
  }

  // 批量发送
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

  // 如果还有待发送的告警，继续定时
  if (alertBuffer.size > 0 && !flushTimer) {
    flushTimer = setTimeout(flushAlertBuffer, FLUSH_INTERVAL)
  }
}

/**
 * 立即刷新所有待发送告警（用于进程退出前）
 */
export async function flushAllAlerts(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  for (const [key, alert] of alertBuffer.entries()) {
    const aggregatedPayload: AlertPayload = {
      ...alert.payload,
      title: alert.count > 1
        ? `${alert.payload.title} (x${alert.count})`
        : alert.payload.title,
    }
    await sendAlert(aggregatedPayload)
    alertBuffer.delete(key)
  }
}

// ============================================
// 告警限流
// ============================================

const rateLimitCache: Map<string, number> = new Map()

/**
 * 带限流的告警发送
 * @param payload 告警内容
 * @param rateLimitKey 限流 key
 * @param rateLimitMs 限流时间窗口 (ms)
 */
export async function sendRateLimitedAlert(
  payload: AlertPayload,
  rateLimitKey: string,
  rateLimitMs: number = 300000 // 默认 5 分钟
): Promise<{ sent: boolean; rateLimited: boolean; channels: string[] }> {
  const now = Date.now()
  const lastSent = rateLimitCache.get(rateLimitKey)

  if (lastSent && now - lastSent < rateLimitMs) {
    return { sent: false, rateLimited: true, channels: [] }
  }

  const result = await sendAlert(payload)

  if (result.sent) {
    rateLimitCache.set(rateLimitKey, now)

    // 清理过期的缓存
    for (const [key, time] of rateLimitCache.entries()) {
      if (now - time > rateLimitMs * 2) {
        rateLimitCache.delete(key)
      }
    }
  }

  return { ...result, rateLimited: false }
}

// ============================================
// 批量执行摘要告警
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

/**
 * 发送抓取批量执行摘要
 */
export async function sendScrapeBatchSummary(summary: ScrapeBatchSummary): Promise<void> {
  const { totalPlatforms, successPlatforms, failedPlatforms, totalDuration, platformResults } = summary

  const failureRate = failedPlatforms.length / totalPlatforms
  const level: AlertPayload['level'] = failureRate > 0.3 ? 'critical' : failureRate > 0.1 ? 'warning' : 'info'

  // 只在有失败或严重降级时发送
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

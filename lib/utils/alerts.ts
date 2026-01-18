/**
 * 告警通知工具
 * 支持 Slack、Discord 等通知渠道
 */

import { createLogger } from './logger'

const logger = createLogger('alerts')

// 告警级别
export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical'

// 告警数据
export interface AlertPayload {
  title: string
  message: string
  severity: AlertSeverity
  source?: string
  timestamp?: string
  metadata?: Record<string, unknown>
  errorId?: string
}

// 通知渠道配置
interface NotificationConfig {
  slack?: {
    webhookUrl: string
    channel?: string
    username?: string
  }
  discord?: {
    webhookUrl: string
  }
  email?: {
    to: string
    from: string
    apiKey: string
  }
}

// 从环境变量获取配置
function getConfig(): NotificationConfig {
  return {
    slack: process.env.SLACK_WEBHOOK_URL
      ? {
          webhookUrl: process.env.SLACK_WEBHOOK_URL,
          channel: process.env.SLACK_CHANNEL || '#alerts',
          username: process.env.SLACK_USERNAME || 'Arena Bot',
        }
      : undefined,
    discord: process.env.DISCORD_WEBHOOK_URL
      ? {
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        }
      : undefined,
  }
}

// 严重性级别对应的颜色
const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  info: '#36a64f',     // 绿色
  warning: '#ffc107',  // 黄色
  error: '#ff7c7c',    // 红色
  critical: '#dc3545', // 深红色
}

// 严重性级别对应的标签
const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: '[信息]',
  warning: '[警告]',
  error: '[错误]',
  critical: '[紧急]',
}

/**
 * 发送 Slack 通知
 */
async function sendSlackAlert(payload: AlertPayload, config: NotificationConfig['slack']): Promise<boolean> {
  if (!config?.webhookUrl) {
    return false
  }

  const slackPayload = {
    channel: config.channel,
    username: config.username,
    icon_emoji: SEVERITY_LABEL[payload.severity],
    attachments: [
      {
        color: SEVERITY_COLORS[payload.severity],
        title: `${SEVERITY_LABEL[payload.severity]} ${payload.title}`,
        text: payload.message,
        fields: [
          {
            title: '严重程度',
            value: payload.severity.toUpperCase(),
            short: true,
          },
          {
            title: '来源',
            value: payload.source || 'Unknown',
            short: true,
          },
          ...(payload.errorId
            ? [
                {
                  title: '错误 ID',
                  value: payload.errorId,
                  short: true,
                },
              ]
            : []),
          {
            title: '时间',
            value: payload.timestamp || new Date().toISOString(),
            short: true,
          },
        ],
        footer: 'Arena Alerts',
        ts: Math.floor(Date.now() / 1000).toString(),
      },
    ],
  }

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    })

    if (!response.ok) {
      logger.error('Slack 通知发送失败', { status: response.status })
      return false
    }

    return true
  } catch (error) {
    logger.error('Slack 通知发送异常', { error: String(error) })
    return false
  }
}

/**
 * 发送 Discord 通知
 */
async function sendDiscordAlert(payload: AlertPayload, config: NotificationConfig['discord']): Promise<boolean> {
  if (!config?.webhookUrl) {
    return false
  }

  const discordPayload = {
    embeds: [
      {
        title: `${SEVERITY_LABEL[payload.severity]} ${payload.title}`,
        description: payload.message,
        color: parseInt(SEVERITY_COLORS[payload.severity].replace('#', ''), 16),
        fields: [
          {
            name: '严重程度',
            value: payload.severity.toUpperCase(),
            inline: true,
          },
          {
            name: '来源',
            value: payload.source || 'Unknown',
            inline: true,
          },
          ...(payload.errorId
            ? [
                {
                  name: '错误 ID',
                  value: payload.errorId,
                  inline: true,
                },
              ]
            : []),
        ],
        timestamp: payload.timestamp || new Date().toISOString(),
        footer: {
          text: 'Arena Alerts',
        },
      },
    ],
  }

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload),
    })

    if (!response.ok) {
      logger.error('Discord 通知发送失败', { status: response.status })
      return false
    }

    return true
  } catch (error) {
    logger.error('Discord 通知发送异常', { error: String(error) })
    return false
  }
}

/**
 * 发送告警通知
 * 自动发送到所有配置的渠道
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  const config = getConfig()
  
  // 添加时间戳
  if (!payload.timestamp) {
    payload.timestamp = new Date().toISOString()
  }
  
  // 记录日志
  logger.warn(`Alert: ${payload.title}`, {
    severity: payload.severity,
    message: payload.message,
    source: payload.source,
  })

  // 并行发送到所有渠道
  const promises: Promise<boolean>[] = []

  if (config.slack) {
    promises.push(sendSlackAlert(payload, config.slack))
  }

  if (config.discord) {
    promises.push(sendDiscordAlert(payload, config.discord))
  }

  // 如果没有配置任何渠道，仅记录日志
  if (promises.length === 0) {
    logger.info('未配置告警渠道，仅记录日志')
    return
  }

  const results = await Promise.allSettled(promises)
  const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length

  if (successCount === 0) {
    logger.error('所有告警渠道发送失败')
  } else if (successCount < promises.length) {
    logger.warn(`部分告警渠道发送失败 (${successCount}/${promises.length})`)
  }
}

/**
 * 便捷方法：发送信息级别告警
 */
export async function alertInfo(title: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
  await sendAlert({ title, message, severity: 'info', metadata })
}

/**
 * 便捷方法：发送警告级别告警
 */
export async function alertWarning(title: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
  await sendAlert({ title, message, severity: 'warning', metadata })
}

/**
 * 便捷方法：发送错误级别告警
 */
export async function alertError(title: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
  await sendAlert({ title, message, severity: 'error', metadata })
}

/**
 * 便捷方法：发送严重级别告警
 */
export async function alertCritical(title: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
  await sendAlert({ title, message, severity: 'critical', metadata })
}

/**
 * 发送错误告警（带错误对象）
 */
export async function alertException(error: Error, context?: string): Promise<void> {
  await sendAlert({
    title: `异常: ${error.name}`,
    message: error.message,
    severity: 'error',
    source: context,
    metadata: {
      stack: error.stack,
    },
  })
}

/**
 * 发送健康检查失败告警
 */
export async function alertHealthCheckFailed(service: string, error?: string): Promise<void> {
  await sendAlert({
    title: '健康检查失败',
    message: `服务 ${service} 健康检查失败${error ? `: ${error}` : ''}`,
    severity: 'critical',
    source: 'health-check',
    metadata: { service },
  })
}

/**
 * 发送限流告警
 */
export async function alertRateLimitExceeded(identifier: string, endpoint: string): Promise<void> {
  await sendAlert({
    title: '限流触发',
    message: `用户 ${identifier} 在 ${endpoint} 触发限流`,
    severity: 'warning',
    source: 'rate-limit',
    metadata: { identifier, endpoint },
  })
}

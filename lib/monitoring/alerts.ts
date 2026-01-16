/**
 * 监控告警模块
 * 定义告警规则、阈值和通知配置
 */

import * as Sentry from '@sentry/nextjs'

// ============================================
// 类型定义
// ============================================

export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical'

export type AlertCategory =
  | 'performance'
  | 'error_rate'
  | 'availability'
  | 'security'
  | 'business'
  | 'infrastructure'

export interface AlertRule {
  /** 规则 ID */
  id: string
  /** 规则名称 */
  name: string
  /** 规则描述 */
  description: string
  /** 分类 */
  category: AlertCategory
  /** 严重级别 */
  severity: AlertSeverity
  /** 阈值条件 */
  condition: AlertCondition
  /** 是否启用 */
  enabled: boolean
  /** 静默时间（秒） */
  silenceDuration?: number
  /** 通知渠道 */
  channels?: AlertChannel[]
}

export interface AlertCondition {
  /** 指标名称 */
  metric: string
  /** 比较运算符 */
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  /** 阈值 */
  threshold: number
  /** 时间窗口（秒） */
  window?: number
  /** 触发次数 */
  count?: number
}

export type AlertChannel = 'sentry' | 'email' | 'slack' | 'webhook'

export interface AlertEvent {
  /** 规则 ID */
  ruleId: string
  /** 规则名称 */
  ruleName: string
  /** 严重级别 */
  severity: AlertSeverity
  /** 消息 */
  message: string
  /** 当前值 */
  value: number
  /** 阈值 */
  threshold: number
  /** 时间戳 */
  timestamp: string
  /** 附加数据 */
  metadata?: Record<string, unknown>
}

// ============================================
// 预定义告警规则
// ============================================

export const AlertRules: AlertRule[] = [
  // 性能告警
  {
    id: 'high_response_time',
    name: 'API 响应时间过长',
    description: '当 API 平均响应时间超过 2 秒时触发',
    category: 'performance',
    severity: 'warning',
    condition: {
      metric: 'api_response_time_avg',
      operator: 'gt',
      threshold: 2000,
      window: 300,
    },
    enabled: true,
    silenceDuration: 300,
    channels: ['sentry'],
  },
  {
    id: 'critical_response_time',
    name: 'API 响应时间严重过长',
    description: '当 API 平均响应时间超过 5 秒时触发',
    category: 'performance',
    severity: 'critical',
    condition: {
      metric: 'api_response_time_avg',
      operator: 'gt',
      threshold: 5000,
      window: 60,
    },
    enabled: true,
    silenceDuration: 60,
    channels: ['sentry', 'slack'],
  },
  {
    id: 'high_lcp',
    name: 'LCP 过高',
    description: '当 Largest Contentful Paint 超过 2.5 秒时触发',
    category: 'performance',
    severity: 'warning',
    condition: {
      metric: 'web_vital_lcp',
      operator: 'gt',
      threshold: 2500,
      window: 300,
    },
    enabled: true,
    channels: ['sentry'],
  },

  // 错误率告警
  {
    id: 'high_error_rate',
    name: '错误率过高',
    description: '当错误率超过 5% 时触发',
    category: 'error_rate',
    severity: 'warning',
    condition: {
      metric: 'error_rate',
      operator: 'gt',
      threshold: 5,
      window: 300,
    },
    enabled: true,
    silenceDuration: 300,
    channels: ['sentry'],
  },
  {
    id: 'critical_error_rate',
    name: '错误率严重过高',
    description: '当错误率超过 15% 时触发',
    category: 'error_rate',
    severity: 'critical',
    condition: {
      metric: 'error_rate',
      operator: 'gt',
      threshold: 15,
      window: 60,
    },
    enabled: true,
    silenceDuration: 60,
    channels: ['sentry', 'slack', 'email'],
  },

  // 可用性告警
  {
    id: 'database_unavailable',
    name: '数据库不可用',
    description: '当数据库连接失败时触发',
    category: 'availability',
    severity: 'critical',
    condition: {
      metric: 'database_health',
      operator: 'eq',
      threshold: 0,
      count: 3,
    },
    enabled: true,
    silenceDuration: 60,
    channels: ['sentry', 'slack', 'email'],
  },
  {
    id: 'redis_unavailable',
    name: 'Redis 不可用',
    description: '当 Redis 连接失败时触发',
    category: 'availability',
    severity: 'error',
    condition: {
      metric: 'redis_health',
      operator: 'eq',
      threshold: 0,
      count: 3,
    },
    enabled: true,
    silenceDuration: 60,
    channels: ['sentry'],
  },

  // 安全告警
  {
    id: 'high_rate_limit',
    name: '速率限制触发频繁',
    description: '当速率限制触发次数过多时告警',
    category: 'security',
    severity: 'warning',
    condition: {
      metric: 'rate_limit_hits',
      operator: 'gt',
      threshold: 100,
      window: 60,
    },
    enabled: true,
    silenceDuration: 300,
    channels: ['sentry'],
  },
  {
    id: 'suspicious_activity',
    name: '可疑活动检测',
    description: '当检测到可疑活动时触发',
    category: 'security',
    severity: 'critical',
    condition: {
      metric: 'suspicious_activity_count',
      operator: 'gt',
      threshold: 0,
      window: 60,
    },
    enabled: true,
    channels: ['sentry', 'slack', 'email'],
  },

  // 业务告警
  {
    id: 'low_conversion',
    name: '转化率下降',
    description: '当注册转化率低于历史平均值 50% 时触发',
    category: 'business',
    severity: 'warning',
    condition: {
      metric: 'registration_conversion_rate',
      operator: 'lt',
      threshold: 50,
      window: 3600,
    },
    enabled: false, // 默认禁用，需要配置基线
    channels: ['sentry'],
  },

  // 基础设施告警
  {
    id: 'high_memory',
    name: '内存使用过高',
    description: '当内存使用超过 85% 时触发',
    category: 'infrastructure',
    severity: 'warning',
    condition: {
      metric: 'memory_usage_percent',
      operator: 'gt',
      threshold: 85,
      window: 300,
    },
    enabled: true,
    silenceDuration: 300,
    channels: ['sentry'],
  },
  {
    id: 'critical_memory',
    name: '内存使用严重过高',
    description: '当内存使用超过 95% 时触发',
    category: 'infrastructure',
    severity: 'critical',
    condition: {
      metric: 'memory_usage_percent',
      operator: 'gt',
      threshold: 95,
      window: 60,
    },
    enabled: true,
    silenceDuration: 60,
    channels: ['sentry', 'slack'],
  },
]

// ============================================
// 告警管理器
// ============================================

class AlertManager {
  private silencedRules: Map<string, number> = new Map()

  /**
   * 检查告警条件
   */
  checkCondition(rule: AlertRule, currentValue: number): boolean {
    const { operator, threshold } = rule.condition

    switch (operator) {
      case 'gt':
        return currentValue > threshold
      case 'gte':
        return currentValue >= threshold
      case 'lt':
        return currentValue < threshold
      case 'lte':
        return currentValue <= threshold
      case 'eq':
        return currentValue === threshold
      case 'neq':
        return currentValue !== threshold
      default:
        return false
    }
  }

  /**
   * 触发告警
   */
  triggerAlert(
    rule: AlertRule,
    currentValue: number,
    metadata?: Record<string, unknown>
  ): void {
    if (!rule.enabled) return

    // 检查静默
    const silenceUntil = this.silencedRules.get(rule.id)
    if (silenceUntil && Date.now() < silenceUntil) {
      console.log(`[Alert] 规则 ${rule.id} 处于静默状态`)
      return
    }

    // 检查条件
    if (!this.checkCondition(rule, currentValue)) {
      return
    }

    const event: AlertEvent = {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      message: this.formatMessage(rule, currentValue),
      value: currentValue,
      threshold: rule.condition.threshold,
      timestamp: new Date().toISOString(),
      metadata,
    }

    // 发送告警
    this.sendAlert(event, rule.channels || ['sentry'])

    // 设置静默
    if (rule.silenceDuration) {
      this.silencedRules.set(rule.id, Date.now() + rule.silenceDuration * 1000)
    }
  }

  /**
   * 格式化告警消息
   */
  private formatMessage(rule: AlertRule, currentValue: number): string {
    const { operator, threshold, metric } = rule.condition
    const opText: Record<string, string> = {
      gt: '大于',
      gte: '大于等于',
      lt: '小于',
      lte: '小于等于',
      eq: '等于',
      neq: '不等于',
    }

    return `${rule.name}: ${metric} 当前值 ${currentValue} ${opText[operator]} 阈值 ${threshold}`
  }

  /**
   * 发送告警到指定渠道
   */
  private sendAlert(event: AlertEvent, channels: AlertChannel[]): void {
    for (const channel of channels) {
      switch (channel) {
        case 'sentry':
          this.sendToSentry(event)
          break
        case 'slack':
          this.sendToSlack(event)
          break
        case 'email':
          this.sendEmail(event)
          break
        case 'webhook':
          this.sendWebhook(event)
          break
      }
    }
  }

  /**
   * 发送到 Sentry
   */
  private sendToSentry(event: AlertEvent): void {
    const levelMap: Record<AlertSeverity, 'info' | 'warning' | 'error'> = {
      info: 'info',
      warning: 'warning',
      error: 'error',
      critical: 'error',
    }

    Sentry.captureMessage(event.message, {
      level: levelMap[event.severity],
      tags: {
        alertRule: event.ruleId,
        alertSeverity: event.severity,
      },
      extra: {
        value: event.value,
        threshold: event.threshold,
        ...event.metadata,
      },
    })

    console.log(`[Alert] Sentry: ${event.message}`)
  }

  /**
   * 发送到 Slack（需要配置 Webhook）
   */
  private async sendToSlack(event: AlertEvent): Promise<void> {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL
    if (!webhookUrl) {
      console.warn('[Alert] Slack Webhook 未配置')
      return
    }

    const colorMap: Record<AlertSeverity, string> = {
      info: '#36a64f',
      warning: '#ffc107',
      error: '#ff5252',
      critical: '#d32f2f',
    }

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachments: [
            {
              color: colorMap[event.severity],
              title: `🚨 ${event.ruleName}`,
              text: event.message,
              fields: [
                { title: '当前值', value: String(event.value), short: true },
                { title: '阈值', value: String(event.threshold), short: true },
                { title: '严重级别', value: event.severity.toUpperCase(), short: true },
                { title: '时间', value: event.timestamp, short: true },
              ],
            },
          ],
        }),
      })
      console.log(`[Alert] Slack: ${event.message}`)
    } catch (error) {
      console.error('[Alert] Slack 发送失败:', error)
    }
  }

  /**
   * 发送邮件（需要配置邮件服务）
   * 配置 ALERT_EMAIL_ENDPOINT 环境变量启用邮件告警
   */
  private async sendEmail(event: AlertEvent): Promise<void> {
    const emailEndpoint = process.env.ALERT_EMAIL_ENDPOINT
    if (!emailEndpoint) {
      // 邮件服务未配置时静默跳过
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Alert] Email 未配置: ${event.message}`)
      }
      return
    }

    try {
      await fetch(emailEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: process.env.ALERT_EMAIL_TO,
          subject: `[${event.severity.toUpperCase()}] ${event.ruleName} 告警`,
          body: event.message,
          metadata: event.metadata,
        }),
      })
    } catch (error) {
      console.error('[Alert] Email 发送失败:', error)
    }
  }

  /**
   * 发送 Webhook
   */
  private async sendWebhook(event: AlertEvent): Promise<void> {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL
    if (!webhookUrl) {
      console.warn('[Alert] Webhook 未配置')
      return
    }

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      })
      console.log(`[Alert] Webhook: ${event.message}`)
    } catch (error) {
      console.error('[Alert] Webhook 发送失败:', error)
    }
  }

  /**
   * 清除静默
   */
  clearSilence(ruleId: string): void {
    this.silencedRules.delete(ruleId)
  }

  /**
   * 获取所有规则
   */
  getRules(): AlertRule[] {
    return AlertRules
  }

  /**
   * 获取规则
   */
  getRule(ruleId: string): AlertRule | undefined {
    return AlertRules.find((r) => r.id === ruleId)
  }
}

// ============================================
// 全局实例
// ============================================

export const alertManager = new AlertManager()

// ============================================
// 便捷函数
// ============================================

/**
 * 检查并触发性能告警
 */
export function checkPerformanceAlert(
  responseTimeMs: number,
  metadata?: Record<string, unknown>
): void {
  const rules = AlertRules.filter(
    (r) => r.category === 'performance' && r.condition.metric === 'api_response_time_avg'
  )
  for (const rule of rules) {
    alertManager.triggerAlert(rule, responseTimeMs, metadata)
  }
}

/**
 * 检查并触发错误率告警
 */
export function checkErrorRateAlert(
  errorRatePercent: number,
  metadata?: Record<string, unknown>
): void {
  const rules = AlertRules.filter(
    (r) => r.category === 'error_rate' && r.condition.metric === 'error_rate'
  )
  for (const rule of rules) {
    alertManager.triggerAlert(rule, errorRatePercent, metadata)
  }
}

/**
 * 检查并触发内存告警
 */
export function checkMemoryAlert(
  usagePercent: number,
  metadata?: Record<string, unknown>
): void {
  const rules = AlertRules.filter(
    (r) => r.category === 'infrastructure' && r.condition.metric === 'memory_usage_percent'
  )
  for (const rule of rules) {
    alertManager.triggerAlert(rule, usagePercent, metadata)
  }
}

// ============================================
// 导出
// ============================================

// Types are exported at definition
export { AlertManager }

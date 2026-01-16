/**
 * 审计日志系统
 * 记录敏感操作用于安全审计和合规
 */

import * as Sentry from '@sentry/nextjs'

// ============================================
// 类型定义
// ============================================

/** 审计事件类型 */
export type AuditEventType =
  // 认证相关
  | 'auth.login'
  | 'auth.logout'
  | 'auth.login_failed'
  | 'auth.password_change'
  | 'auth.password_reset'
  | 'auth.mfa_enabled'
  | 'auth.mfa_disabled'
  // 用户操作
  | 'user.profile_update'
  | 'user.email_change'
  | 'user.avatar_change'
  | 'user.delete_account'
  // 数据操作
  | 'data.create'
  | 'data.update'
  | 'data.delete'
  | 'data.export'
  // 权限相关
  | 'permission.role_change'
  | 'permission.access_denied'
  | 'permission.admin_action'
  // 交易所连接
  | 'exchange.connect'
  | 'exchange.disconnect'
  | 'exchange.sync'
  // 安全事件
  | 'security.suspicious_activity'
  | 'security.rate_limit_exceeded'
  | 'security.invalid_token'
  | 'security.ip_blocked'
  // 支付相关
  | 'payment.subscription_created'
  | 'payment.subscription_cancelled'
  | 'payment.payment_success'
  | 'payment.payment_failed'

/** 审计事件严重级别 */
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical'

/** 审计日志条目 */
export interface AuditLogEntry {
  /** 事件类型 */
  type: AuditEventType
  /** 严重级别 */
  severity: AuditSeverity
  /** 用户 ID（如果有） */
  userId?: string
  /** 用户 handle */
  userHandle?: string
  /** 事件描述 */
  message: string
  /** 附加数据 */
  metadata?: Record<string, unknown>
  /** IP 地址 */
  ip?: string
  /** 用户代理 */
  userAgent?: string
  /** 请求 ID */
  requestId?: string
  /** 资源类型 */
  resourceType?: string
  /** 资源 ID */
  resourceId?: string
  /** 时间戳 */
  timestamp: string
  /** 操作是否成功 */
  success: boolean
  /** 错误信息（如果失败） */
  error?: string
}

// ============================================
// 审计日志配置
// ============================================

interface AuditConfig {
  /** 是否启用 */
  enabled: boolean
  /** 是否发送到 Sentry */
  sendToSentry: boolean
  /** 是否记录到控制台 */
  logToConsole: boolean
  /** 批量发送大小 */
  batchSize: number
  /** 批量发送间隔（毫秒） */
  batchInterval: number
}

const defaultConfig: AuditConfig = {
  enabled: true,
  sendToSentry: true,
  logToConsole: process.env.NODE_ENV === 'development',
  batchSize: 10,
  batchInterval: 5000,
}

// ============================================
// 审计日志服务
// ============================================

class AuditLogService {
  private config: AuditConfig
  private buffer: AuditLogEntry[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(config: Partial<AuditConfig> = {}) {
    this.config = { ...defaultConfig, ...config }
  }

  /**
   * 记录审计事件
   */
  log(entry: Omit<AuditLogEntry, 'timestamp'>): void {
    if (!this.config.enabled) return

    const fullEntry: AuditLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    }

    // 控制台日志
    if (this.config.logToConsole) {
      this.logToConsole(fullEntry)
    }

    // 添加到 Sentry breadcrumb
    if (this.config.sendToSentry) {
      this.addSentryBreadcrumb(fullEntry)
    }

    // 添加到缓冲区
    this.buffer.push(fullEntry)

    // 检查是否需要刷新
    if (this.buffer.length >= this.config.batchSize) {
      this.flush()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.config.batchInterval)
    }
  }

  /**
   * 记录认证事件
   */
  logAuth(
    type: Extract<AuditEventType, `auth.${string}`>,
    options: {
      userId?: string
      userHandle?: string
      success: boolean
      ip?: string
      userAgent?: string
      error?: string
      metadata?: Record<string, unknown>
    }
  ): void {
    const messages: Record<string, string> = {
      'auth.login': options.success ? '用户登录成功' : '用户登录失败',
      'auth.logout': '用户退出登录',
      'auth.login_failed': '登录尝试失败',
      'auth.password_change': '用户修改密码',
      'auth.password_reset': '用户重置密码',
      'auth.mfa_enabled': '用户启用两步验证',
      'auth.mfa_disabled': '用户禁用两步验证',
    }

    this.log({
      type,
      severity: options.success ? 'info' : 'warning',
      message: messages[type] || type,
      ...options,
    })
  }

  /**
   * 记录数据操作
   */
  logDataOperation(
    operation: 'create' | 'update' | 'delete' | 'export',
    options: {
      userId?: string
      userHandle?: string
      resourceType: string
      resourceId?: string
      success: boolean
      metadata?: Record<string, unknown>
      error?: string
    }
  ): void {
    const type = `data.${operation}` as AuditEventType

    this.log({
      type,
      severity: operation === 'delete' ? 'warning' : 'info',
      message: `${options.userHandle || options.userId || '用户'} ${operation} ${options.resourceType}${options.resourceId ? ` (${options.resourceId})` : ''}`,
      ...options,
    })
  }

  /**
   * 记录安全事件
   */
  logSecurityEvent(
    type: Extract<AuditEventType, `security.${string}`>,
    options: {
      userId?: string
      userHandle?: string
      ip?: string
      userAgent?: string
      message: string
      metadata?: Record<string, unknown>
    }
  ): void {
    const severityMap: Record<string, AuditSeverity> = {
      'security.suspicious_activity': 'critical',
      'security.rate_limit_exceeded': 'warning',
      'security.invalid_token': 'warning',
      'security.ip_blocked': 'critical',
    }

    this.log({
      type,
      severity: severityMap[type] || 'warning',
      success: false,
      ...options,
    })

    // 严重安全事件发送 Sentry 告警
    if (severityMap[type] === 'critical') {
      Sentry.captureMessage(options.message, {
        level: 'warning',
        tags: {
          auditType: type,
          userId: options.userId,
        },
        extra: options.metadata,
      })
    }
  }

  /**
   * 记录权限变更
   */
  logPermissionChange(options: {
    userId: string
    userHandle?: string
    targetUserId: string
    targetUserHandle?: string
    action: 'grant' | 'revoke'
    role: string
    success: boolean
    metadata?: Record<string, unknown>
  }): void {
    this.log({
      type: 'permission.role_change',
      severity: 'warning',
      userId: options.userId,
      userHandle: options.userHandle,
      message: `${options.userHandle || options.userId} ${options.action === 'grant' ? '授予' : '撤销'} ${options.targetUserHandle || options.targetUserId} 的 ${options.role} 角色`,
      success: options.success,
      metadata: {
        ...options.metadata,
        targetUserId: options.targetUserId,
        targetUserHandle: options.targetUserHandle,
        action: options.action,
        role: options.role,
      },
    })
  }

  /**
   * 刷新缓冲区
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (this.buffer.length === 0) return

    const entries = [...this.buffer]
    this.buffer = []

    try {
      // 这里可以发送到后端日志服务
      // 目前只是添加到 Sentry
      if (this.config.sendToSentry && entries.length > 0) {
        Sentry.addBreadcrumb({
          category: 'audit.batch',
          message: `批量审计日志: ${entries.length} 条`,
          level: 'info',
          data: {
            count: entries.length,
            types: [...new Set(entries.map(e => e.type))],
          },
        })
      }

      // 可选：发送到日志收集服务（如 Elasticsearch、CloudWatch、Datadog 等）
      // 配置 AUDIT_LOG_ENDPOINT 环境变量启用外部日志服务
      if (process.env.AUDIT_LOG_ENDPOINT) {
        await fetch(process.env.AUDIT_LOG_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries }),
        }).catch(() => {
          // 静默失败，不影响主流程
        })
      }
    } catch (error) {
      console.error('[Audit] 刷新审计日志失败:', error)
      // 失败时将条目放回缓冲区
      this.buffer = [...entries, ...this.buffer]
    }
  }

  /**
   * 输出到控制台
   */
  private logToConsole(entry: AuditLogEntry): void {
    const severityColors: Record<AuditSeverity, string> = {
      info: '\x1b[36m', // 青色
      warning: '\x1b[33m', // 黄色
      error: '\x1b[31m', // 红色
      critical: '\x1b[35m', // 紫色
    }
    const reset = '\x1b[0m'
    const color = severityColors[entry.severity]

    console.log(
      `${color}[AUDIT]${reset} [${entry.timestamp}] [${entry.type}] ${entry.message}`,
      entry.metadata ? JSON.stringify(entry.metadata) : ''
    )
  }

  /**
   * 添加 Sentry breadcrumb
   */
  private addSentryBreadcrumb(entry: AuditLogEntry): void {
    const levelMap: Record<AuditSeverity, 'info' | 'warning' | 'error'> = {
      info: 'info',
      warning: 'warning',
      error: 'error',
      critical: 'error',
    }

    Sentry.addBreadcrumb({
      category: `audit.${entry.type}`,
      message: entry.message,
      level: levelMap[entry.severity],
      data: {
        userId: entry.userId,
        userHandle: entry.userHandle,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        success: entry.success,
        ip: entry.ip,
        ...entry.metadata,
      },
    })
  }
}

// ============================================
// 全局实例
// ============================================

export const auditLog = new AuditLogService()

// ============================================
// 便捷函数
// ============================================

/**
 * 记录用户登录
 */
export function logUserLogin(
  userId: string,
  userHandle: string,
  options: {
    success: boolean
    ip?: string
    userAgent?: string
    error?: string
    method?: 'password' | 'oauth' | 'magic_link'
  }
): void {
  auditLog.logAuth(options.success ? 'auth.login' : 'auth.login_failed', {
    userId,
    userHandle,
    success: options.success,
    ip: options.ip,
    userAgent: options.userAgent,
    error: options.error,
    metadata: {
      method: options.method,
    },
  })
}

/**
 * 记录用户登出
 */
export function logUserLogout(userId: string, userHandle: string): void {
  auditLog.logAuth('auth.logout', {
    userId,
    userHandle,
    success: true,
  })
}

/**
 * 记录数据创建
 */
export function logDataCreate(
  resourceType: string,
  resourceId: string,
  userId: string,
  userHandle?: string
): void {
  auditLog.logDataOperation('create', {
    userId,
    userHandle,
    resourceType,
    resourceId,
    success: true,
  })
}

/**
 * 记录数据删除
 */
export function logDataDelete(
  resourceType: string,
  resourceId: string,
  userId: string,
  userHandle?: string
): void {
  auditLog.logDataOperation('delete', {
    userId,
    userHandle,
    resourceType,
    resourceId,
    success: true,
  })
}

/**
 * 记录可疑活动
 */
export function logSuspiciousActivity(
  message: string,
  options: {
    userId?: string
    userHandle?: string
    ip?: string
    userAgent?: string
    metadata?: Record<string, unknown>
  }
): void {
  auditLog.logSecurityEvent('security.suspicious_activity', {
    message,
    ...options,
  })
}

/**
 * 记录速率限制
 */
export function logRateLimitExceeded(
  ip: string,
  endpoint: string,
  userId?: string
): void {
  auditLog.logSecurityEvent('security.rate_limit_exceeded', {
    ip,
    userId,
    message: `速率限制: ${endpoint}`,
    metadata: { endpoint },
  })
}

// ============================================
// 导出
// ============================================

// Types are exported at definition
export { AuditLogService }

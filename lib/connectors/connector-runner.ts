/**
 * Connector Runner - Unified execution framework
 * 
 * 包装现有 Connectors，添加：
 * - Redis 状态存储
 * - PipelineLogger 日志
 * - Telegram 告警
 * - 错误处理和重试
 * - 性能监控
 * 
 * Usage:
 *   const runner = new ConnectorRunner(hyperliquidConnector, { platform: 'hyperliquid' })
 *   await runner.execute({ window: '90d' })
 */

import { PipelineLogger, type PipelineLogHandle } from '@/lib/services/pipeline-logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { tieredSet, tieredGet, tieredDel } from '@/lib/cache/redis-layer'
import { dataLogger } from '@/lib/utils/logger'
import type { RankingWindow } from '@/lib/types/leaderboard'

// ============================================
// Sentry Integration (optional — no-ops if Sentry unavailable)
// ============================================

let Sentry: typeof import('@sentry/nextjs') | null = null
try {
  // Dynamic import so the module is not required at build time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Sentry = require('@sentry/nextjs')
} catch (_err) {
  // Sentry not installed or not configured — that is fine
}

// ============================================
// 类型定义
// ============================================

export interface ConnectorStatus {
  platform: string
  lastRun: string
  status: 'success' | 'error' | 'running'
  recordsProcessed: number
  errors: number
  consecutiveFailures: number
  lastError?: string
  nextRetry?: string
  metadata?: Record<string, unknown>
}

export interface RunnerConfig {
  /** Platform name */
  platform: string
  
  /** Enable Telegram alerts */
  enableAlerts?: boolean
  
  /** Alert threshold for consecutive failures */
  alertThreshold?: number
  
  /** Custom timeout (ms) */
  timeoutMs?: number
  
  /** Max retries */
  maxRetries?: number
  
  /** Backoff multiplier */
  backoffMultiplier?: number
}

export interface ExecuteParams {
  /** Window period */
  window?: RankingWindow
  
  /** Page number */
  page?: number
  
  /** Page size */
  pageSize?: number
  
  /** Additional params */
  [key: string]: unknown
}

export interface ExecuteResult {
  success: boolean
  recordsProcessed: number
  errors: string[]
  durationMs: number
}

// ============================================
// Connector Runner
// ============================================

/**
 * Generic connector executor with monitoring
 */
export class ConnectorRunner<T = unknown> {
  private config: Required<RunnerConfig>
  private connector: T
  private logHandle: PipelineLogHandle | null = null

  constructor(connector: T, config: RunnerConfig) {
    this.connector = connector
    this.config = {
      platform: config.platform,
      enableAlerts: config.enableAlerts ?? true,
      alertThreshold: config.alertThreshold ?? 3,
      timeoutMs: config.timeoutMs ?? 60000,
      maxRetries: config.maxRetries ?? 3,
      backoffMultiplier: config.backoffMultiplier ?? 2,
    }
  }

  // ============================================
  // Main Execution
  // ============================================

  /**
   * Execute connector with full monitoring
   */
  async execute(params?: ExecuteParams): Promise<ExecuteResult> {
    const jobName = `${this.config.platform}-connector`
    const startTime = Date.now()
    const errors: string[] = []
    let recordsProcessed = 0

    // 1. Start pipeline logging
    this.logHandle = await PipelineLogger.start(jobName, {
      params,
      startedAt: new Date().toISOString(),
    })

    // 2. Update Redis status: running
    await this.updateStatus({
      status: 'running',
      recordsProcessed: 0,
      errors: 0,
    })

    // Sentry span for observability
    const sentrySpanFn = async (): Promise<ExecuteResult> => {
    try {
      // 3. Execute connector logic with timeout
      const result = await this.withTimeout(
        this.executeConnector(params),
        this.config.timeoutMs
      )

      recordsProcessed = result.recordsProcessed ?? 0
      const durationMs = Date.now() - startTime

      // 4. Check for warnings
      await this.checkWarnings(recordsProcessed, durationMs)

      // 5. Success logging
      await this.logHandle!.success(recordsProcessed, {
        durationMs,
        params,
      })

      // 6. Update Redis status: success
      await this.updateStatus({
        status: 'success',
        recordsProcessed,
        errors: 0,
        consecutiveFailures: 0, // Reset on success
        metadata: { durationMs, params },
      })

      dataLogger.info(`[${this.config.platform}] 执行成功: ${recordsProcessed} 条记录, 耗时 ${durationMs}ms`)

      return {
        success: true,
        recordsProcessed,
        errors,
        durationMs,
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      errors.push(errorMessage)
      const durationMs = Date.now() - startTime

      dataLogger.error(`[${this.config.platform}] 执行失败:`, error)

      // 7. Error logging
      await this.logHandle?.error(error instanceof Error ? error : new Error(String(error)), {
        durationMs,
        params,
      })

      // 8. Get consecutive failures
      const consecutiveFailures = await PipelineLogger.getConsecutiveFailures(jobName)

      // 9. Update Redis status: error
      await this.updateStatus({
        status: 'error',
        recordsProcessed: 0,
        errors: 1,
        consecutiveFailures: consecutiveFailures + 1,
        lastError: errorMessage,
        nextRetry: this.calculateNextRetry(consecutiveFailures + 1),
        metadata: { durationMs, params },
      })

      // 10. Send alert if threshold exceeded
      if (consecutiveFailures >= this.config.alertThreshold - 1) {
        await this.sendAlert({
          title: `${this.config.platform} 连续失败 ${consecutiveFailures + 1} 次`,
          message: errorMessage,
          level: 'critical',
          details: {
            平台: this.config.platform,
            连续失败次数: consecutiveFailures + 1,
            最后错误: errorMessage,
            参数: JSON.stringify(params),
          },
        })
      }

      return {
        success: false,
        recordsProcessed,
        errors,
        durationMs,
      }
    }
    } // end sentrySpanFn

    // Wrap in Sentry span if available
    if (Sentry?.startSpan) {
      return Sentry.startSpan(
        {
          name: `connector.execute`,
          op: 'connector',
          attributes: {
            'connector.platform': this.config.platform,
            'connector.window': params?.window ?? 'default',
          },
        },
        async (span) => {
          const result = await sentrySpanFn()
          span.setAttribute('connector.records', result.recordsProcessed)
          span.setAttribute('connector.duration_ms', result.durationMs)
          span.setAttribute('connector.success', result.success)
          if (!result.success) {
            span.setStatus({ code: 2, message: result.errors[0] ?? 'unknown error' })
          }
          return result
        }
      )
    }

    return sentrySpanFn()
  }

  // ============================================
  // Connector Execution (platform-specific)
  // ============================================

  /**
   * Execute connector logic
   * Override this in subclasses for specific connector types
   */
  protected async executeConnector(params?: ExecuteParams): Promise<{ recordsProcessed: number }> {
    // Try to detect connector type and call appropriate method
    const connector = this.connector as Record<string, unknown>

    // UnifiedPlatformConnector interface (new architecture 2026-03-11)
    if (typeof connector.execute === 'function') {
      const result = await (connector.execute as (p?: ExecuteParams) => Promise<{ recordsProcessed: number }>)(params)
      return { recordsProcessed: result.recordsProcessed || 0 }
    }

    // Legacy PlatformConnector interface
    if (typeof connector.discoverLeaderboard === 'function') {
      const window = params?.window || '90d'
      const traders = await (connector.discoverLeaderboard as (w: string) => Promise<unknown[] | null>)(window)
      return { recordsProcessed: traders?.length || 0 }
    }

    // Newer getTraderList interface
    if (typeof connector.getTraderList === 'function') {
      const traders = await (connector.getTraderList as (p?: ExecuteParams) => Promise<unknown[] | null>)(params)
      return { recordsProcessed: traders?.length || 0 }
    }

    throw new Error(`Connector does not implement known interface`)
  }

  // ============================================
  // Warning Checks
  // ============================================

  /**
   * Check for potential issues
   */
  private async checkWarnings(recordsProcessed: number, durationMs: number): Promise<void> {
    // Zero results warning
    if (recordsProcessed === 0) {
      await this.sendAlert({
        title: `${this.config.platform} 返回 0 结果`,
        message: `可能是 API 问题或查询参数错误`,
        level: 'warning',
      })
    }

    // Slow response warning (>10s)
    if (durationMs > 10000) {
      await this.sendAlert({
        title: `${this.config.platform} 响应慢`,
        message: `耗时 ${(durationMs / 1000).toFixed(1)}s，可能需要优化`,
        level: 'warning',
        details: {
          耗时: `${(durationMs / 1000).toFixed(1)}s`,
        },
      })
    }
  }

  // ============================================
  // Redis Status Management
  // ============================================

  /**
   * Update connector status in Redis
   */
  private async updateStatus(partial: Partial<ConnectorStatus>): Promise<void> {
    try {
      const current = await this.getStatus()
      const updated: ConnectorStatus = {
        platform: this.config.platform,
        lastRun: new Date().toISOString(),
        status: partial.status ?? current?.status ?? 'running',
        recordsProcessed: partial.recordsProcessed ?? current?.recordsProcessed ?? 0,
        errors: partial.errors ?? current?.errors ?? 0,
        consecutiveFailures: partial.consecutiveFailures ?? current?.consecutiveFailures ?? 0,
        lastError: partial.lastError ?? current?.lastError,
        nextRetry: partial.nextRetry ?? current?.nextRetry,
        metadata: partial.metadata ?? current?.metadata,
      }

      const key = this.getStatusKey()
      await tieredSet(key, updated, 'warm', ['connector-status', `platform:${this.config.platform}`])
    } catch (error) {
      dataLogger.warn(`[${this.config.platform}] Redis 状态更新失败:`, error)
    }
  }

  /**
   * Get current connector status from Redis
   */
  async getStatus(): Promise<ConnectorStatus | null> {
    try {
      const key = this.getStatusKey()
      const { data } = await tieredGet<ConnectorStatus>(key, 'warm')
      return data
    } catch (error) {
      dataLogger.warn(`[${this.config.platform}] Redis 状态读取失败:`, error)
      return null
    }
  }

  /**
   * Clear status
   */
  async clearStatus(): Promise<void> {
    try {
      const key = this.getStatusKey()
      await tieredDel(key)
    } catch (error) {
      dataLogger.warn(`[${this.config.platform}] Redis 状态清除失败:`, error)
    }
  }

  /**
   * Get Redis status key
   */
  private getStatusKey(): string {
    return `connector:status:${this.config.platform}`
  }

  /**
   * Calculate next retry time
   */
  private calculateNextRetry(consecutiveFailures: number): string {
    const backoffMinutes = Math.min(60, 5 * Math.pow(2, consecutiveFailures - 1))
    const nextRetry = new Date(Date.now() + backoffMinutes * 60 * 1000)
    return nextRetry.toISOString()
  }

  // ============================================
  // Helpers
  // ============================================

  /**
   * Execute with timeout
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ])
  }

  /**
   * Send Telegram alert
   */
  private async sendAlert(payload: {
    title: string
    message: string
    level: 'info' | 'warning' | 'critical'
    details?: Record<string, unknown>
  }): Promise<void> {
    if (!this.config.enableAlerts) return

    try {
      await sendRateLimitedAlert(
        payload,
        `${this.config.platform}:${payload.level}`,
        300000 // 5 minutes rate limit
      )
    } catch (error) {
      dataLogger.warn(`[${this.config.platform}] 告警发送失败:`, error)
    }
  }
}

// ============================================
// Batch Runner
// ============================================

/**
 * Run multiple connectors in parallel
 */
export async function runConnectorsBatch(
  runners: Array<{ runner: ConnectorRunner; params?: ExecuteParams }>,
  options?: {
    maxConcurrent?: number
    continueOnError?: boolean
  }
): Promise<{
  results: ExecuteResult[]
  summary: {
    total: number
    success: number
    failed: number
    totalRecords: number
    totalDuration: number
  }
}> {
  const maxConcurrent = options?.maxConcurrent ?? 5
  const continueOnError = options?.continueOnError ?? true

  const results: ExecuteResult[] = []
  const startTime = Date.now()

  // Execute in batches
  for (let i = 0; i < runners.length; i += maxConcurrent) {
    const batch = runners.slice(i, i + maxConcurrent)
    const batchResults = await Promise.allSettled(
      batch.map(({ runner, params }) => runner.execute(params))
    )

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value)
      } else {
        results.push({
          success: false,
          recordsProcessed: 0,
          errors: [result.reason?.message || 'Unknown error'],
          durationMs: 0,
        })

        if (!continueOnError) {
          throw result.reason
        }
      }
    }
  }

  const summary = {
    total: results.length,
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    totalRecords: results.reduce((sum, r) => sum + r.recordsProcessed, 0),
    totalDuration: Date.now() - startTime,
  }

  dataLogger.info('[ConnectorBatch] 批量执行完成:', summary)

  return { results, summary }
}

// ============================================
// Utility Functions
// ============================================

/**
 * Get all connector statuses from Redis
 */
export async function getAllConnectorStatuses(platforms: string[]): Promise<ConnectorStatus[]> {
  const statuses: ConnectorStatus[] = []

  for (const platform of platforms) {
    try {
      const key = `connector:status:${platform}`
      const { data } = await tieredGet<ConnectorStatus>(key, 'warm')
      if (data) {
        statuses.push(data)
      }
    } catch (error) {
      dataLogger.warn(`[ConnectorStatus] 获取 ${platform} 状态失败:`, error)
    }
  }

  return statuses
}

/**
 * Clear all connector statuses
 */
export async function clearAllConnectorStatuses(platforms: string[]): Promise<number> {
  let cleared = 0

  for (const platform of platforms) {
    try {
      const key = `connector:status:${platform}`
      await tieredDel(key)
      cleared++
    } catch (error) {
      dataLogger.warn(`[ConnectorStatus] 清除 ${platform} 状态失败:`, error)
    }
  }

  return cleared
}

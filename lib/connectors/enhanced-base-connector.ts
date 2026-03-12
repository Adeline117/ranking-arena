/**
 * Enhanced Base Exchange Connector
 * 
 * 统一的交易所数据采集框架，集成：
 * - Redis 状态存储
 * - PipelineLogger 日志
 * - Telegram 告警
 * - 统一错误处理（3次重试 + backoff）
 * - Rate limiting
 * - Timeout 配置
 */

import { PipelineLogger, type PipelineLogHandle } from '@/lib/services/pipeline-logger'
import { sendAlert, sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { tieredSet, tieredGet } from '@/lib/cache/redis-layer'
import { dataLogger } from '@/lib/utils/logger'

// ============================================
// 类型定义
// ============================================

export interface TraderData {
  source_trader_id: string
  handle?: string
  avatar_url?: string
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
  roi?: number | null
  pnl?: number | null
  followers?: number | null
  // Multi-period fields
  roi_7d?: number | null
  roi_30d?: number | null
  roi_90d?: number | null
  win_rate_7d?: number | null
  win_rate_30d?: number | null
  win_rate_90d?: number | null
  max_drawdown_7d?: number | null
  max_drawdown_30d?: number | null
  max_drawdown_90d?: number | null
}

export interface ListParams {
  page?: number
  pageSize?: number
  sortType?: number | string
  period?: '7d' | '30d' | '90d'
  chainId?: number
}

export interface EnrichmentResult {
  success: boolean
  updates: Partial<TraderData>
  error?: string
}

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

export interface ConnectorConfig {
  /** Platform name (e.g., 'hyperliquid', 'binance') */
  platform: string
  
  /** Max concurrent requests */
  maxConcurrent?: number
  
  /** Delay between requests (ms) */
  delayMs?: number
  
  /** Request timeout (ms) */
  timeoutMs?: number
  
  /** Max retries on failure */
  maxRetries?: number
  
  /** Backoff multiplier for retries */
  backoffMultiplier?: number
  
  /** Enable Telegram alerts */
  enableAlerts?: boolean
  
  /** Alert threshold for consecutive failures */
  alertThreshold?: number
}

// ============================================
// Enhanced Base Connector
// ============================================

export abstract class EnhancedBaseConnector {
  protected platform: string
  protected headers: Record<string, string>
  protected config: Required<ConnectorConfig>
  protected rateLimiter: RateLimiter
  private logHandle: PipelineLogHandle | null = null

  constructor(config: ConnectorConfig) {
    this.platform = config.platform
    this.config = {
      platform: config.platform,
      maxConcurrent: config.maxConcurrent ?? 1,
      delayMs: config.delayMs ?? 200,
      timeoutMs: config.timeoutMs ?? 30000,
      maxRetries: config.maxRetries ?? 3,
      backoffMultiplier: config.backoffMultiplier ?? 2,
      enableAlerts: config.enableAlerts ?? true,
      alertThreshold: config.alertThreshold ?? 3,
    }

    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }

    this.rateLimiter = new RateLimiter(
      this.config.maxConcurrent,
      this.config.delayMs
    )
  }

  // ============================================
  // Abstract Methods (must implement)
  // ============================================

  /**
   * Get detailed trader data by ID
   */
  abstract getTraderDetail(traderId: string, params?: ListParams): Promise<TraderData | null>

  /**
   * Get list of traders (for pagination/discovery)
   */
  abstract getTraderList(params?: ListParams): Promise<TraderData[]>

  // ============================================
  // Execution Lifecycle
  // ============================================

  /**
   * Execute data collection with full monitoring
   */
  async execute(params?: ListParams): Promise<{ 
    success: boolean
    recordsProcessed: number
    errors: string[]
  }> {
    const jobName = `${this.platform}-connector`
    
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

    const startTime = Date.now()
    const errors: string[] = []
    let recordsProcessed = 0

    try {
      // 3. Fetch trader list
      const traders = await this.withRetry(() => this.getTraderList(params))
      recordsProcessed = traders.length

      // 4. Check for zero results (potential issue)
      if (traders.length === 0) {
        await this.sendAlert({
          title: `${this.platform} 返回 0 结果`,
          message: `参数: ${JSON.stringify(params)}`,
          level: 'warning',
        })
      }

      // 5. Success logging
      await this.logHandle.success(recordsProcessed, {
        durationMs: Date.now() - startTime,
        params,
      })

      // 6. Update Redis status: success
      await this.updateStatus({
        status: 'success',
        recordsProcessed,
        errors: 0,
        consecutiveFailures: 0, // Reset on success
      })

      return { success: true, recordsProcessed, errors }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      errors.push(errorMessage)

      // 7. Error logging
      await this.logHandle.error(error, {
        durationMs: Date.now() - startTime,
        params,
      })

      // 8. Get consecutive failures count
      const consecutiveFailures = await PipelineLogger.getConsecutiveFailures(jobName)

      // 9. Update Redis status: error
      await this.updateStatus({
        status: 'error',
        recordsProcessed: 0,
        errors: 1,
        consecutiveFailures: consecutiveFailures + 1,
        lastError: errorMessage,
        nextRetry: this.calculateNextRetry(consecutiveFailures + 1),
      })

      // 10. Send alert if threshold exceeded
      if (consecutiveFailures >= this.config.alertThreshold - 1) {
        await this.sendAlert({
          title: `${this.platform} 连续失败 ${consecutiveFailures + 1} 次`,
          message: errorMessage,
          level: 'critical',
          details: {
            平台: this.platform,
            连续失败次数: consecutiveFailures + 1,
            最后错误: errorMessage,
            参数: JSON.stringify(params),
          },
        })
      }

      return { success: false, recordsProcessed, errors }
    }
  }

  // ============================================
  // Retry Logic with Exponential Backoff
  // ============================================

  /**
   * Execute with retry + backoff
   */
  protected async withRetry<T>(
    fn: () => Promise<T>,
    attempt = 0
  ): Promise<T> {
    try {
      return await this.withTimeout(fn(), this.config.timeoutMs)
    } catch (error) {
      if (attempt >= this.config.maxRetries - 1) {
        throw error
      }

      const backoffMs = this.config.delayMs * Math.pow(this.config.backoffMultiplier, attempt)
      dataLogger.warn(`[${this.platform}] 重试 ${attempt + 1}/${this.config.maxRetries}，等待 ${backoffMs}ms`)
      
      await this.sleep(backoffMs)
      return this.withRetry(fn, attempt + 1)
    }
  }

  /**
   * Execute with timeout
   */
  protected async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ])
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
        platform: this.platform,
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
      await tieredSet(key, updated, 'warm', ['connector-status', `platform:${this.platform}`])
    } catch (error) {
      dataLogger.warn(`[${this.platform}] Redis 状态更新失败:`, error)
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
      dataLogger.warn(`[${this.platform}] Redis 状态读取失败:`, error)
      return null
    }
  }

  /**
   * Get Redis status key
   */
  private getStatusKey(): string {
    return `connector:status:${this.platform}`
  }

  /**
   * Calculate next retry time based on failures
   */
  private calculateNextRetry(consecutiveFailures: number): string {
    const backoffMinutes = Math.min(60, 5 * Math.pow(2, consecutiveFailures - 1))
    const nextRetry = new Date(Date.now() + backoffMinutes * 60 * 1000)
    return nextRetry.toISOString()
  }

  // ============================================
  // Telegram Alerts
  // ============================================

  /**
   * Send Telegram alert
   */
  protected async sendAlert(payload: {
    title: string
    message: string
    level: 'info' | 'warning' | 'critical'
    details?: Record<string, unknown>
  }): Promise<void> {
    if (!this.config.enableAlerts) return

    try {
      await sendRateLimitedAlert(
        payload,
        `${this.platform}:${payload.level}`,
        300000 // 5 minutes rate limit
      )
    } catch (error) {
      dataLogger.warn(`[${this.platform}] 告警发送失败:`, error)
    }
  }

  // ============================================
  // Enrichment (from base-connector-enrichment.ts)
  // ============================================

  /**
   * Enrich a trader snapshot with missing fields
   */
  async enrichSnapshot(snapshot: {
    source_trader_id: string
    handle?: string
    win_rate?: number | null
    max_drawdown?: number | null
    trades_count?: number | null
    roi?: number | null
  }, params?: ListParams): Promise<EnrichmentResult> {
    try {
      const detail = await this.withRetry(() => 
        this.getTraderDetail(snapshot.source_trader_id, params)
      )

      if (!detail) {
        return { success: false, updates: {}, error: 'Trader not found' }
      }

      const updates: Partial<TraderData> = {}
      
      // Only update null/missing fields
      if (snapshot.win_rate == null && detail.win_rate != null) {
        updates.win_rate = detail.win_rate
      }
      if (snapshot.max_drawdown == null && detail.max_drawdown != null) {
        updates.max_drawdown = detail.max_drawdown
      }
      if (snapshot.trades_count == null && detail.trades_count != null) {
        updates.trades_count = detail.trades_count
      }
      if (snapshot.roi == null && detail.roi != null) {
        updates.roi = detail.roi
      }

      return { success: true, updates }
    } catch (error) {
      return {
        success: false,
        updates: {},
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Sleep helper for rate limiting
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Parse number safely (no fabricated values!)
   */
  protected parseNum(v: unknown): number | null {
    if (v == null || v === '') return null
    const n = parseFloat(String(v).replace('%', '').trim())
    return isNaN(n) ? null : n
  }

  /**
   * Validate win rate (0-100%)
   */
  protected validateWinRate(wr: number | null): number | null {
    if (wr == null) return null
    if (wr < 0 || wr > 100) return null
    return wr
  }

  /**
   * Validate max drawdown (store as positive %)
   */
  protected validateMaxDrawdown(mdd: number | null): number | null {
    if (mdd == null) return null
    const abs = Math.abs(mdd)
    if (abs > 100) return null // Invalid
    return abs
  }

  /**
   * Fetch with rate limiting
   */
  protected async fetchWithRateLimit<T>(
    url: string,
    options?: RequestInit
  ): Promise<T> {
    return this.rateLimiter.add(async () => {
      const response = await fetch(url, {
        ...options,
        headers: { ...this.headers, ...options?.headers },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      return response.json() as Promise<T>
    })
  }
}

// ============================================
// Rate Limiter
// ============================================

export class RateLimiter {
  private queue: Array<() => Promise<unknown>> = []
  private running = 0
  private maxConcurrent: number
  private delayMs: number

  constructor(maxConcurrent = 1, delayMs = 200) {
    this.maxConcurrent = maxConcurrent
    this.delayMs = delayMs
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn()
          resolve(result)
        } catch (error) {
          reject(error)
        }
      })
      this.process()
    })
  }

  private async process() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const fn = this.queue.shift()
      if (!fn) continue

      this.running++
      try {
        await fn()
      } finally {
        this.running--
        if (this.delayMs > 0) {
          await new Promise(r => setTimeout(r, this.delayMs))
        }
        this.process()
      }
    }
  }
}

// ============================================
// Utility: Get All Connector Statuses
// ============================================

/**
 * Get status for all registered connectors
 */
export async function getAllConnectorStatuses(): Promise<ConnectorStatus[]> {
  try {
    // This would query all connector:status:* keys from Redis
    // For now, return empty array (implement when registry is ready)
    return []
  } catch (error) {
    dataLogger.warn('[ConnectorStatus] 批量查询失败:', error)
    return []
  }
}

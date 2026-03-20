/**
 * Base Exchange Connector
 * 
 * Unified interface for all exchange APIs
 */

/** @deprecated Write-path type for data pipeline. Use UnifiedTrader from '@/lib/types/unified-trader' for reads. */
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

export abstract class BaseExchangeConnector {
  protected source: string
  protected headers: Record<string, string>

  constructor(source: string) {
    this.source = source
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }
  }

  /**
   * Get detailed trader data by ID
   */
  abstract getTraderDetail(traderId: string, params?: ListParams): Promise<TraderData | null>

  /**
   * Get list of traders (for pagination/discovery)
   */
  abstract getTraderList(params?: ListParams): Promise<TraderData[]>

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
      const detail = await this.getTraderDetail(snapshot.source_trader_id, params)
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
    return !Number.isFinite(n) ? null : n
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
}

/**
 * Rate limiter for API calls
 */
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

/**
 * Unified Platform Connector Adapter
 * 
 * Wraps existing fetcher functions into the new connector interface.
 * Enables gradual migration from batch-fetch-traders to unified-connector.
 * 
 * Usage:
 *   const connector = new UnifiedPlatformConnector('binance_futures')
 *   const runner = new ConnectorRunner(connector, { platform: 'binance_futures' })
 *   await runner.execute({ window: '90d' })
 */

import { createSupabaseAdmin } from '@/lib/cron/utils'
import { getInlineFetcher } from '@/lib/cron/fetchers'
import { runEnrichment } from '@/lib/cron/enrichment-runner'
import type { RankingWindow } from '@/lib/types/leaderboard'
import { dataLogger } from '@/lib/utils/logger'
import type { ExecuteResult } from './connector-runner'

export interface UnifiedConnectorConfig {
  /** Platform identifier */
  platform: string
  
  /** Enable enrichment (equity curves, stats detail) */
  enableEnrichment?: boolean
  
  /** Enrichment limit per period */
  enrichmentLimit?: number
  
  /** Periods to fetch (default: all) */
  periods?: RankingWindow[]
  
  /** Timeout in milliseconds (default: 300000 = 5min) */
  timeoutMs?: number
}

/**
 * Unified connector that wraps existing fetchers + enrichment
 */
export class UnifiedPlatformConnector {
  private config: Required<UnifiedConnectorConfig>
  
  constructor(config: UnifiedConnectorConfig | string) {
    if (typeof config === 'string') {
      this.config = {
        platform: config,
        enableEnrichment: true,
        enrichmentLimit: 300,
        periods: ['7d', '30d', '90d'],
        timeoutMs: 300000, // Default 5min
      }
    } else {
      this.config = {
        platform: config.platform,
        enableEnrichment: config.enableEnrichment ?? true,
        enrichmentLimit: config.enrichmentLimit ?? 300,
        periods: config.periods ?? ['7d', '30d', '90d'],
        timeoutMs: config.timeoutMs ?? 300000, // Default 5min
      }
    }
  }
  
  /**
   * Execute full fetch + enrich pipeline
   */
  async execute(params?: { window?: RankingWindow }): Promise<ExecuteResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let recordsProcessed = 0
    
    try {
      // Step 1: Fetch traders (leaderboard)
      const supabase = createSupabaseAdmin()
      if (!supabase) {
        throw new Error('Supabase not configured')
      }
      
      const fetcher = getInlineFetcher(this.config.platform)
      if (!fetcher) {
        throw new Error(`No fetcher found for platform: ${this.config.platform}`)
      }
      
      // Determine which periods to fetch
      const periodsToFetch = params?.window 
        ? [params.window]
        : this.config.periods
      
      // Map window format: 7d → 7D
      const periodsMapped = periodsToFetch.map(p => p.toUpperCase().replace('D', 'D') as '7D' | '30D' | '90D')
      
      dataLogger.info(`[UnifiedConnector] ${this.config.platform}: fetching ${periodsMapped.join(', ')}`)
      
      // Fetch traders
      const fetchResult = await fetcher(supabase, periodsMapped)
      
      // Collect errors
      for (const [period, result] of Object.entries(fetchResult.periods)) {
        if (result.error) {
          errors.push(`${period}: ${result.error}`)
        }
        recordsProcessed += result.saved || 0
      }
      
      // Step 2: Enrichment (optional)
      if (this.config.enableEnrichment && recordsProcessed > 0) {
        dataLogger.info(`[UnifiedConnector] ${this.config.platform}: enriching top ${this.config.enrichmentLimit} traders`)
        
        for (const period of periodsMapped) {
          try {
            const enrichResult = await runEnrichment({
              platform: this.config.platform,
              period,
              limit: this.config.enrichmentLimit,
            })
            
            if (!enrichResult.ok) {
              errors.push(`Enrichment ${period}: ${enrichResult.summary.failed} failed`)
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            errors.push(`Enrichment ${period}: ${errMsg}`)
          }
        }
      }
      
      return {
        success: errors.length === 0,
        recordsProcessed,
        errors,
        durationMs: Date.now() - startTime,
      }
      
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      dataLogger.error(`[UnifiedConnector] ${this.config.platform} failed:`, err)
      
      return {
        success: false,
        recordsProcessed,
        errors: [...errors, errMsg],
        durationMs: Date.now() - startTime,
      }
    }
  }
}

/**
 * Platform connector registry
 * Maps platform names to connector configs
 * 
 * Timeout guidance:
 * - Small platforms (<100 traders): 300s (5min)
 * - Medium platforms (100-300 traders): 420s (7min)
 * - Large platforms (>300 traders, onchain): 600s (10min)
 */
export const PLATFORM_CONNECTORS: Record<string, UnifiedConnectorConfig> = {
  // Group A: High-priority CEX (every 3h) - Fast platforms keep enrichment
  binance_futures: { platform: 'binance_futures', enrichmentLimit: 200, timeoutMs: 420000 },
  binance_spot: { platform: 'binance_spot', enrichmentLimit: 100, timeoutMs: 300000 },
  bybit: { platform: 'bybit', enrichmentLimit: 150, timeoutMs: 360000 },
  bitget_futures: { platform: 'bitget_futures', enrichmentLimit: 60, timeoutMs: 300000, enableEnrichment: false },
  okx_futures: { platform: 'okx_futures', enrichmentLimit: 80, timeoutMs: 300000, enableEnrichment: false },
  
  // Group B: Top DEX (every 4h) - Disable enrichment to fit Cloudflare 120s timeout
  hyperliquid: { platform: 'hyperliquid', enrichmentLimit: 150, timeoutMs: 600000, enableEnrichment: false },
  gmx: { platform: 'gmx', enrichmentLimit: 150, timeoutMs: 600000, enableEnrichment: false }, // Dedicated enrich-gmx job handles enrichment
  jupiter_perps: { platform: 'jupiter_perps', enrichmentLimit: 150, timeoutMs: 600000, enableEnrichment: false },
  
  // Group C: Mid-priority (every 4h)
  okx_web3: { platform: 'okx_web3', enrichmentLimit: 100, timeoutMs: 300000, enableEnrichment: false },
  aevo: { platform: 'aevo', enrichmentLimit: 150, timeoutMs: 600000, enableEnrichment: false },
  xt: { platform: 'xt', enrichmentLimit: 60, timeoutMs: 300000 },
  
  // Group D-I: Lower priority (every 6h) - Disable enrichment for large/slow platforms
  gains: { platform: 'gains', enrichmentLimit: 150, timeoutMs: 600000, enableEnrichment: false },
  htx_futures: { platform: 'htx_futures', enrichmentLimit: 40, timeoutMs: 300000 },
  dydx: { platform: 'dydx', enrichmentLimit: 150, timeoutMs: 600000, enableEnrichment: false },
  bybit_spot: { platform: 'bybit_spot', enrichmentLimit: 50, timeoutMs: 300000 },
  coinex: { platform: 'coinex', enrichmentLimit: 40, timeoutMs: 300000 },
  binance_web3: { platform: 'binance_web3', enrichmentLimit: 50, timeoutMs: 300000, enableEnrichment: false }, // Wallet-based, no equity curve
  bitfinex: { platform: 'bitfinex', enrichmentLimit: 50, timeoutMs: 300000 },
  mexc: { platform: 'mexc', enrichmentLimit: 60, timeoutMs: 300000 },
  bingx: { platform: 'bingx', enrichmentLimit: 40, timeoutMs: 300000, enableEnrichment: false }, // CF-protected, enrichment not supported
  gateio: { platform: 'gateio', enrichmentLimit: 60, timeoutMs: 300000 },
  btcc: { platform: 'btcc', enrichmentLimit: 30, timeoutMs: 300000 },
  drift: { platform: 'drift', enrichmentLimit: 150, timeoutMs: 600000, enableEnrichment: false },
  bitunix: { platform: 'bitunix', enrichmentLimit: 50, timeoutMs: 300000 },
  web3_bot: { platform: 'web3_bot', enrichmentLimit: 50, timeoutMs: 300000 },
  toobit: { platform: 'toobit', enrichmentLimit: 50, timeoutMs: 300000 },
  etoro: { platform: 'etoro', enrichmentLimit: 200, timeoutMs: 420000 },
}

/**
 * Create a unified connector for a platform
 */
export function createUnifiedConnector(platform: string): UnifiedPlatformConnector {
  const config = PLATFORM_CONNECTORS[platform]
  if (!config) {
    throw new Error(`Platform not registered: ${platform}`)
  }
  return new UnifiedPlatformConnector(config)
}

/**
 * Get all registered platform names
 */
export function getRegisteredPlatforms(): string[] {
  return Object.keys(PLATFORM_CONNECTORS)
}

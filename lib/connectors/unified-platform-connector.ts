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

import { runEnrichment } from '@/lib/cron/enrichment-runner'
import type { RankingWindow } from '@/lib/types/leaderboard'
import { dataLogger } from '@/lib/utils/logger'
import type { ExecuteResult } from './connector-runner'
import { connectorRegistry, initializeConnectors } from './registry'
import { runConnectorBatch } from '@/lib/pipeline/connector-db-adapter'
import { createSupabaseAdmin } from '@/lib/cron/utils'

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
   * Execute full fetch + enrich pipeline via ConnectorRegistry
   */
  async execute(params?: { window?: RankingWindow }): Promise<ExecuteResult> {
    const startTime = Date.now()
    const errors: string[] = []
    let recordsProcessed = 0

    try {
      const supabase = createSupabaseAdmin()
      if (!supabase) {
        throw new Error('Supabase not configured')
      }

      // Initialize connectors if needed
      await initializeConnectors()

      // Look up the connector from the registry
      // Platform names like 'binance_futures' need to be mapped
      const platform = this.config.platform as import('@/lib/types/leaderboard').LeaderboardPlatform
      const marketType = (PLATFORM_CONNECTORS[this.config.platform]?.platform !== this.config.platform
        ? undefined
        : undefined) as import('@/lib/types/leaderboard').MarketType | undefined

      // Try to find connector - try platform name directly
      const connector = connectorRegistry.get(platform, marketType || 'futures' as import('@/lib/types/leaderboard').MarketType)
      if (!connector) {
        throw new Error(`No connector registered for platform: ${this.config.platform}`)
      }

      // Determine which periods to fetch
      const periodsToFetch = params?.window
        ? [params.window]
        : this.config.periods

      dataLogger.info(`[UnifiedConnector] ${this.config.platform}: fetching ${periodsToFetch.join(', ')} via ConnectorRegistry`)

      // Fetch traders via connector
      const fetchResult = await runConnectorBatch(connector, {
        supabase,
        windows: periodsToFetch,
        limit: 500,
        sourceOverride: this.config.platform,
      })

      // Collect errors
      for (const [period, result] of Object.entries(fetchResult.periods)) {
        if (result.error) {
          errors.push(`${period}: ${result.error}`)
        }
        recordsProcessed += result.saved || 0
      }

      // Step 2: Enrichment (optional)
      const periodsMapped = periodsToFetch.map(p => p.toUpperCase().replace('D', 'D') as '7D' | '30D' | '90D')
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
  binance_futures: { platform: 'binance_futures', enrichmentLimit: 200, timeoutMs: 600000 }, // 10min (was 7min, too short)
  // binance_spot: REMOVED 2026-03-14 - repeatedly hangs 45-76min
  bybit: { platform: 'bybit', enrichmentLimit: 150, timeoutMs: 600000 }, // 10min (was 6min, too short)
  // bitget_futures: PERMANENTLY REMOVED (2026-03-18) - VPS scraper repeatedly hangs 44+ min (6th stuck), blocks pipeline
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
  mexc: { platform: 'mexc', enrichmentLimit: 60, timeoutMs: 600000 }, // 10min (was 5min, VPS scraper slow)
  bingx: { platform: 'bingx', enrichmentLimit: 40, timeoutMs: 600000, enableEnrichment: false }, // CF-protected, enrichment not supported; 10min (was 5min, VPS scraper slow)
  gateio: { platform: 'gateio', enrichmentLimit: 60, timeoutMs: 600000 }, // 10min (was 5min, VPS scraper slow)
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

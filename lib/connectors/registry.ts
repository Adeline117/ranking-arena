/**
 * Connector Registry
 *
 * Central registry for all platform connectors.
 * Manages connector instances, rate limiters, and platform capabilities.
 *
 * Uses lazy initialization: connectors are only imported and constructed
 * on first access via getOrInit(), reducing cold start time.
 *
 * Supports both:
 * - New multi-exchange ConnectorRegistry (register/get by platform+marketType)
 * - Legacy getConnector (singleton by GranularPlatform)
 */

import type { LeaderboardPlatform, MarketType, PlatformCapabilities, GranularPlatform } from '../types/leaderboard'
import type { PlatformConnector } from './types'

/** Union type for both new-style and legacy connectors in the registry.
 * Uses any to support both BaseConnector and BaseConnectorLegacy subclasses
 * without requiring type assertions at every call site in job-runner.ts. */

 
type AnyConnector = any
import { RedisRateLimiter } from './redis-rate-limiter'

// Legacy connector imports removed — _deprecated directory was deleted.
// Legacy getConnector() now returns null for all platforms.

// ============================================
// New ConnectorRegistry (multi-exchange, lazy init)
// ============================================

/** Registry key for connector lookup */
type RegistryKey = `${LeaderboardPlatform}:${MarketType}`

/** Registered connector entry */
interface ConnectorEntry {
  connector: PlatformConnector
  rateLimiter: RedisRateLimiter
}

/** Factory function that creates and returns a connector */
type ConnectorFactory = () => Promise<PlatformConnector>

class ConnectorRegistry {
  private connectors: Map<RegistryKey, ConnectorEntry> = new Map()
  /** Lazy initializer factories — called on first getOrInit() */
  private factories: Map<RegistryKey, ConnectorFactory> = new Map()
  /** Tracks in-flight initializations to handle concurrent first-access */
  private initializing: Map<RegistryKey, Promise<PlatformConnector | null>> = new Map()

  /**
   * Register a connector for a platform/market combination.
   * (Eager registration — connector already instantiated.)
   */
  register(connector: PlatformConnector): void {
    const key: RegistryKey = `${connector.platform}:${connector.marketType}`

    const rateLimiter = new RedisRateLimiter({
      platform: key,
      rpm: connector.capabilities.rate_limit.rpm,
      concurrency: connector.capabilities.rate_limit.concurrency,
    })

    connector.setRateLimiter(rateLimiter)
    this.connectors.set(key, { connector, rateLimiter })
    // Remove factory if one was registered (eager takes precedence)
    this.factories.delete(key)
  }

  /**
   * Register a lazy initializer for a platform/market combination.
   * The factory is called only on the first getOrInit() call.
   */
  registerLazy(key: RegistryKey, factory: ConnectorFactory): void {
    // Don't overwrite an already-initialized connector
    if (!this.connectors.has(key)) {
      this.factories.set(key, factory)
    }
  }

  /**
   * Get a connector for a platform/market combination (synchronous).
   * Returns null if the connector hasn't been initialized yet.
   * For lazy-initialized connectors, use getOrInit() instead.
   */
  get(platform: LeaderboardPlatform, marketType: MarketType): PlatformConnector | null {
    const key: RegistryKey = `${platform}:${marketType}`
    return this.connectors.get(key)?.connector || null
  }

  /**
   * Get a connector, initializing it lazily if needed.
   * Thread-safe: concurrent first-access calls share the same init promise.
   */
  async getOrInit(platform: LeaderboardPlatform, marketType: MarketType): Promise<PlatformConnector | null> {
    const key: RegistryKey = `${platform}:${marketType}`

    // Fast path: already initialized
    const existing = this.connectors.get(key)
    if (existing) return existing.connector

    // Check if there's a factory registered
    const factory = this.factories.get(key)
    if (!factory) return null

    // Check if initialization is already in-flight (concurrent access guard)
    const inFlight = this.initializing.get(key)
    if (inFlight) return inFlight

    // Start initialization
    const initPromise = (async (): Promise<PlatformConnector | null> => {
      try {
        const connector = await factory()
        this.register(connector) // This also removes the factory
        return connector
      } catch (err) {
        // Log via proper logger instead of console
        const errorMsg = err instanceof Error ? err.message : String(err)
        console.error(
          `[ConnectorRegistry] Failed to lazy-init ${key}: ${errorMsg}. Factory retained for retry on next call.`
        )
        // Do NOT delete the factory — keep it so the next getOrInit() call retries initialization
        // Previously: this.factories.delete(key) caused permanent failure after a transient error
        return null
      } finally {
        this.initializing.delete(key)
      }
    })()

    this.initializing.set(key, initPromise)
    return initPromise
  }

  /**
   * Get all registered (already initialized) connectors.
   */
  getAll(): PlatformConnector[] {
    return Array.from(this.connectors.values()).map(e => e.connector)
  }

  /**
   * Get all registered platform capabilities.
   */
  getCapabilities(): PlatformCapabilities[] {
    return this.getAll().map(c => c.capabilities)
  }

  /**
   * Get the rate limiter for a platform/market combination.
   */
  getRateLimiter(platform: LeaderboardPlatform, marketType: MarketType): RedisRateLimiter | null {
    const key: RegistryKey = `${platform}:${marketType}`
    return this.connectors.get(key)?.rateLimiter || null
  }

  /**
   * Check if a connector is registered or has a factory for a platform/market.
   */
  has(platform: LeaderboardPlatform, marketType: MarketType): boolean {
    const key: RegistryKey = `${platform}:${marketType}`
    return this.connectors.has(key) || this.factories.has(key)
  }

  /**
   * Get all platforms that have registered connectors (including pending lazy factories).
   */
  getRegisteredPlatforms(): Array<{ platform: LeaderboardPlatform; marketType: MarketType }> {
    const keys = new Set<RegistryKey>([
      ...this.connectors.keys(),
      ...this.factories.keys(),
    ])
    return Array.from(keys).map(key => {
      const [platform, marketType] = key.split(':') as [LeaderboardPlatform, MarketType]
      return { platform, marketType }
    })
  }
}

// Singleton registry instance
export const connectorRegistry = new ConnectorRegistry()

/**
 * Initialize all available connectors.
 *
 * Uses lazy registration: only registers factory functions, not actual instances.
 * Connectors are imported and constructed on first access via connectorRegistry.getOrInit().
 * This reduces cold start time from ~500ms (28 dynamic imports) to near-zero.
 *
 * Call this once at application startup.
 */
export async function initializeConnectors(): Promise<void> {
  // Smart routing: determine proxy URL per-platform from route-config.
  const { requiresProxy } = await import('./route-config')
  const proxyUrl = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || undefined

  // Helper: pass proxyUrl only if the platform requires it (geo-blocked / WAF)
  const proxyFor = (platform: string) => requiresProxy(platform) ? { proxyUrl } : {}

  // Helper: register a lazy factory for a standard connector
   
  const lazy = (key: string, importFn: () => Promise<Record<string, any>>, connectorName: string, platform: string) => {
    connectorRegistry.registerLazy(key as RegistryKey, async () => {
      const mod = await importFn()
      const ConnectorClass = mod[connectorName]
      return new ConnectorClass(proxyFor(platform))
    })
  }

  // CEX Connectors
  lazy('binance_futures:futures', () => import('./platforms/binance-futures'), 'BinanceFuturesConnector', 'binance_futures')
  lazy('bybit:futures', () => import('./platforms/bybit-futures'), 'BybitFuturesConnector', 'bybit')
  lazy('bybit_spot:spot', () => import('./platforms/bybit-spot'), 'BybitSpotConnector', 'bybit_spot')
  lazy('bitget_futures:futures', () => import('./platforms/bitget-futures'), 'BitgetFuturesConnector', 'bitget_futures')
  lazy('mexc:futures', () => import('./platforms/mexc-futures'), 'MexcFuturesConnector', 'mexc')
  lazy('coinex:futures', () => import('./platforms/coinex-futures'), 'CoinexFuturesConnector', 'coinex')
  lazy('okx_futures:futures', () => import('./platforms/okx-futures'), 'OkxFuturesConnector', 'okx_futures')
  lazy('okx_spot:spot', () => import('./platforms/okx-spot'), 'OkxSpotConnector', 'okx_spot')
  lazy('kucoin:futures', () => import('./platforms/kucoin-futures'), 'KucoinFuturesConnector', 'kucoin')
  // bitmart — DEAD
  lazy('phemex:futures', () => import('./platforms/phemex-futures'), 'PhemexFuturesConnector', 'phemex')
  lazy('htx_futures:futures', () => import('./platforms/htx-futures'), 'HtxFuturesConnector', 'htx_futures')
  lazy('weex:futures', () => import('./platforms/weex-futures'), 'WeexFuturesConnector', 'weex')
  lazy('bingx:futures', () => import('./platforms/bingx-futures'), 'BingxFuturesConnector', 'bingx')
  lazy('gateio:futures', () => import('./platforms/gateio-futures'), 'GateioFuturesConnector', 'gateio')
  lazy('xt:futures', () => import('./platforms/xt-futures'), 'XtFuturesConnector', 'xt')
  lazy('lbank:futures', () => import('./platforms/lbank-futures'), 'LbankFuturesConnector', 'lbank')
  lazy('blofin:futures', () => import('./platforms/blofin-futures'), 'BlofinFuturesConnector', 'blofin')

  // New CEX Connectors
  lazy('btcc:futures', () => import('./platforms/btcc-futures'), 'BtccFuturesConnector', 'btcc')
  lazy('bitunix:futures', () => import('./platforms/bitunix-futures'), 'BitunixFuturesConnector', 'bitunix')
  lazy('bitfinex:futures', () => import('./platforms/bitfinex-futures'), 'BitfinexFuturesConnector', 'bitfinex')
  lazy('toobit:futures', () => import('./platforms/toobit-futures'), 'ToobitFuturesConnector', 'toobit')
  // crypto_com: DELETED — no copy trading feature on web (2026-03-19)
  lazy('etoro:spot', () => import('./platforms/etoro-spot'), 'EtoroSpotConnector', 'etoro')
  lazy('bitget_spot:spot', () => import('./platforms/bitget-spot'), 'BitgetSpotConnector', 'bitget_spot')
  lazy('binance_spot:spot', () => import('./platforms/binance-spot'), 'BinanceSpotConnector', 'binance_futures')

  // DEX Connectors
  lazy('hyperliquid:perp', () => import('./platforms/hyperliquid-perp'), 'HyperliquidPerpConnector', 'hyperliquid')
  lazy('dydx:perp', () => import('./platforms/dydx-perp'), 'DydxPerpConnector', 'dydx')
  lazy('gmx:perp', () => import('./platforms/gmx-perp'), 'GmxPerpConnector', 'gmx')
  lazy('gains:perp', () => import('./platforms/gains-perp'), 'GainsPerpConnector', 'gains')
  lazy('kwenta:perp', () => import('./platforms/kwenta-perp'), 'KwentaPerpConnector', 'kwenta')
  connectorRegistry.registerLazy('mux:perp' as RegistryKey, async () => {
    const { MuxPerpConnector } = await import('./platforms/mux-perp')
    return new MuxPerpConnector()
  })
  lazy('aevo:perp', () => import('./platforms/aevo-perp'), 'AevoPerpConnector', 'aevo')
  lazy('jupiter_perps:perp', () => import('./platforms/jupiter-perps-perp'), 'JupiterPerpsPerpConnector', 'jupiter_perps')
  lazy('drift:perp', () => import('./platforms/drift-perp'), 'DriftPerpConnector', 'drift')
  // DEAD (2026-04): vertex (no public leaderboard API), apex_pro (geo-blocked, no API), rabbitx (DNS dead)

  // New platforms (Wave 2)
  lazy('woox:copy', () => import('./platforms/woox-copy'), 'WooxCopyConnector', 'woox')
  lazy('polymarket:copy', () => import('./platforms/polymarket-prediction'), 'PolymarketPredictionConnector', 'polymarket')
  lazy('copin:perp', () => import('./platforms/copin-perp'), 'CopinPerpConnector', 'copin')

  // Web3 Connectors
  lazy('okx_web3:web3', () => import('./platforms/okx-web3'), 'OkxWeb3Connector', 'okx_web3')
  lazy('binance_web3:web3', () => import('./platforms/binance-web3'), 'BinanceWeb3Connector', 'binance_web3')
  connectorRegistry.registerLazy('web3_bot:spot' as RegistryKey, async () => {
    const { Web3BotConnector } = await import('./platforms/web3-bot')
    return new Web3BotConnector()
  })
}

// ============================================
// Legacy Registry (singleton by GranularPlatform)
// ============================================

/**
 * Platforms with implemented legacy connectors.
 * Add new platforms here as their connectors are built.
 */
const IMPLEMENTED_PLATFORMS: GranularPlatform[] = [
  'binance_futures',
  'binance_spot', // RE-ENABLED 2026-03-19: added 30s per-page + 4min total timeout
  'bybit',
  'bitget_futures',
  'bitget_spot',
  'okx',
  'mexc',
  // 'kucoin', — DEAD: APIs 404 since 2026-03
  'coinex',
  'hyperliquid',
  // Pending implementation:
  // 'binance_web3',
  // 'okx_wallet',
  // 'gmx',
  // 'dydx',
  // 'bitmart',
  // 'phemex',
  // 'htx',
  // 'weex',
]

// Legacy connector instances (singleton per platform)
const legacyConnectors = new Map<GranularPlatform, AnyConnector>()

/**
 * Get or create a legacy connector for the specified platform.
 * Returns null if no connector is implemented for the platform.
 */
export function getConnector(platform: GranularPlatform): AnyConnector | null {
  if (legacyConnectors.has(platform)) {
    return legacyConnectors.get(platform)!
  }

  const connector = createLegacyConnector(platform)
  if (connector) {
    legacyConnectors.set(platform, connector)
  }
  return connector
}

function createLegacyConnector(_platform: GranularPlatform): AnyConnector | null {
  // All legacy connectors removed — use connectorRegistry (new-style) instead.
  return null
}

/** Get list of platforms with implemented legacy connectors */
export function getAvailablePlatforms(): GranularPlatform[] {
  return [...IMPLEMENTED_PLATFORMS]
}

/**
 * Connector Registry
 *
 * Central registry for all platform connectors.
 * Manages connector instances, rate limiters, and platform capabilities.
 */

import type { LeaderboardPlatform, MarketType, PlatformCapabilities } from '../types/leaderboard'
import type { PlatformConnector } from './types'
import { TokenBucketRateLimiter } from './rate-limiter'

/** Registry key for connector lookup */
type RegistryKey = `${LeaderboardPlatform}:${MarketType}`

/** Registered connector entry */
interface ConnectorEntry {
  connector: PlatformConnector
  rateLimiter: TokenBucketRateLimiter
}

class ConnectorRegistry {
  private connectors: Map<RegistryKey, ConnectorEntry> = new Map()

  /**
   * Register a connector for a platform/market combination.
   */
  register(connector: PlatformConnector): void {
    const key: RegistryKey = `${connector.platform}:${connector.marketType}`

    const rateLimiter = new TokenBucketRateLimiter({
      rpm: connector.capabilities.rate_limit.rpm,
      concurrency: connector.capabilities.rate_limit.concurrency,
    })

    connector.setRateLimiter(rateLimiter)
    this.connectors.set(key, { connector, rateLimiter })
  }

  /**
   * Get a connector for a platform/market combination.
   */
  get(platform: LeaderboardPlatform, marketType: MarketType): PlatformConnector | null {
    const key: RegistryKey = `${platform}:${marketType}`
    return this.connectors.get(key)?.connector || null
  }

  /**
   * Get all registered connectors.
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
  getRateLimiter(platform: LeaderboardPlatform, marketType: MarketType): TokenBucketRateLimiter | null {
    const key: RegistryKey = `${platform}:${marketType}`
    return this.connectors.get(key)?.rateLimiter || null
  }

  /**
   * Check if a connector is registered for a platform/market.
   */
  has(platform: LeaderboardPlatform, marketType: MarketType): boolean {
    const key: RegistryKey = `${platform}:${marketType}`
    return this.connectors.has(key)
  }

  /**
   * Get all platforms that have registered connectors.
   */
  getRegisteredPlatforms(): Array<{ platform: LeaderboardPlatform; marketType: MarketType }> {
    return Array.from(this.connectors.keys()).map(key => {
      const [platform, marketType] = key.split(':') as [LeaderboardPlatform, MarketType]
      return { platform, marketType }
    })
  }
}

// Singleton registry instance
export const connectorRegistry = new ConnectorRegistry()

/**
 * Initialize all available connectors.
 * Call this once at application startup.
 */
export async function initializeConnectors(): Promise<void> {
  // Dynamic imports to avoid circular dependencies and allow tree-shaking
  const { BinanceFuturesConnector } = await import('./platforms/binance-futures')
  const { BybitFuturesConnector } = await import('./platforms/bybit-futures')
  const { BitgetFuturesConnector } = await import('./platforms/bitget-futures')
  const { MexcFuturesConnector } = await import('./platforms/mexc-futures')
  const { CoinexFuturesConnector } = await import('./platforms/coinex-futures')
  const { OkxFuturesConnector } = await import('./platforms/okx-futures')
  const { KucoinFuturesConnector } = await import('./platforms/kucoin-futures')
  const { BitmartFuturesConnector } = await import('./platforms/bitmart-futures')
  const { PhemexFuturesConnector } = await import('./platforms/phemex-futures')
  const { HtxFuturesConnector } = await import('./platforms/htx-futures')
  const { WeexFuturesConnector } = await import('./platforms/weex-futures')
  const { HyperliquidPerpConnector } = await import('./platforms/hyperliquid-perp')
  const { DydxPerpConnector } = await import('./platforms/dydx-perp')
  const { GmxPerpConnector } = await import('./platforms/gmx-perp')

  // CEX Connectors
  connectorRegistry.register(new BinanceFuturesConnector())
  connectorRegistry.register(new BybitFuturesConnector())
  connectorRegistry.register(new BitgetFuturesConnector())
  connectorRegistry.register(new MexcFuturesConnector())
  connectorRegistry.register(new CoinexFuturesConnector())
  connectorRegistry.register(new OkxFuturesConnector())
  connectorRegistry.register(new KucoinFuturesConnector())
  connectorRegistry.register(new BitmartFuturesConnector())
  connectorRegistry.register(new PhemexFuturesConnector())
  connectorRegistry.register(new HtxFuturesConnector())
  connectorRegistry.register(new WeexFuturesConnector())

  // DEX Connectors
  connectorRegistry.register(new HyperliquidPerpConnector())
  connectorRegistry.register(new DydxPerpConnector())
  connectorRegistry.register(new GmxPerpConnector())
}

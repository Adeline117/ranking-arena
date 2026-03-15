/**
 * Connector Registry
 *
 * Central registry for all platform connectors.
 * Manages connector instances, rate limiters, and platform capabilities.
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
import { TokenBucketRateLimiter } from './rate-limiter'

// Legacy connector imports (deprecated — kept for run-worker backward compat)
import { BinanceFuturesConnector } from './_deprecated/binance-futures'
import { BinanceSpotConnector } from './_deprecated/binance-spot'
import { BybitConnector } from './_deprecated/bybit'
import { BitgetFuturesConnector } from './_deprecated/bitget-futures'
import { OKXConnector } from './_deprecated/okx'
import { MEXCConnector } from './_deprecated/mexc'
// import { KuCoinConnector } from './_deprecated/kucoin' // DEAD
import { HyperliquidConnector } from './_deprecated/hyperliquid'
import { CoinExConnector } from './_deprecated/coinex'
import { BitgetSpotConnector } from './_deprecated/bitget-spot'

// ============================================
// New ConnectorRegistry (multi-exchange)
// ============================================

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
  // const { KucoinFuturesConnector } = await import('./platforms/kucoin-futures') // DEAD
  // const { BitmartFuturesConnector } = await import('./platforms/bitmart-futures') // DEAD
  const { PhemexFuturesConnector } = await import('./platforms/phemex-futures')
  const { HtxFuturesConnector } = await import('./platforms/htx-futures')
  const { WeexFuturesConnector } = await import('./platforms/weex-futures')
  const { HyperliquidPerpConnector } = await import('./platforms/hyperliquid-perp')
  const { DydxPerpConnector } = await import('./platforms/dydx-perp')
  const { GmxPerpConnector } = await import('./platforms/gmx-perp')
  const { BingxFuturesConnector } = await import('./platforms/bingx-futures')
  const { GateioFuturesConnector } = await import('./platforms/gateio-futures')
  const { XtFuturesConnector } = await import('./platforms/xt-futures')
  const { GainsPerpConnector } = await import('./platforms/gains-perp')
  const { KwentaPerpConnector } = await import('./platforms/kwenta-perp')
  const { MuxPerpConnector } = await import('./platforms/mux-perp')
  const { LbankFuturesConnector } = await import('./platforms/lbank-futures')
  const { BlofinFuturesConnector } = await import('./platforms/blofin-futures')

  // New connectors (Phase 2A migration)
  const { EtoroSpotConnector } = await import('./platforms/etoro-spot')
  const { BtccFuturesConnector } = await import('./platforms/btcc-futures')
  const { BitunixFuturesConnector } = await import('./platforms/bitunix-futures')
  const { DriftPerpConnector } = await import('./platforms/drift-perp')
  const { BitfinexFuturesConnector } = await import('./platforms/bitfinex-futures')
  const { AevoPerpConnector } = await import('./platforms/aevo-perp')
  const { JupiterPerpsPerpConnector } = await import('./platforms/jupiter-perps-perp')
  const { ToobitFuturesConnector } = await import('./platforms/toobit-futures')
  const { BitgetSpotConnector: BitgetSpotConnectorNew } = await import('./platforms/bitget-spot')
  const { Web3BotConnector } = await import('./platforms/web3-bot')
  const { OkxWeb3Connector } = await import('./platforms/okx-web3')
  const { BinanceWeb3Connector } = await import('./platforms/binance-web3')
  const { BinanceSpotConnector: BinanceSpotConnectorNew } = await import('./platforms/binance-spot')

  // Proxy URL for geo-blocked exchanges (Binance, OKX, BingX, HTX, dYdX, etc.)
  // CF Worker is US-based = also geo-blocked. Use VPS SG proxy instead.
  const proxyUrl = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || undefined

  // CEX Connectors — all use VPS proxy for geo-blocked API access
  connectorRegistry.register(new BinanceFuturesConnector({ proxyUrl }))
  connectorRegistry.register(new BybitFuturesConnector({ proxyUrl }))
  connectorRegistry.register(new BitgetFuturesConnector({ proxyUrl }))
  connectorRegistry.register(new MexcFuturesConnector({ proxyUrl }))
  // CoinEx: blocked from Vercel hnd1, needs VPS proxy
  connectorRegistry.register(new CoinexFuturesConnector({ proxyUrl }))
  // OKX: v5 API blocked from Vercel hnd1, needs VPS proxy
  connectorRegistry.register(new OkxFuturesConnector({ proxyUrl }))
  // connectorRegistry.register(new KucoinFuturesConnector()) // DEAD: APIs 404 since 2026-03
  // connectorRegistry.register(new BitmartFuturesConnector({ proxyUrl })) // DEAD
  connectorRegistry.register(new PhemexFuturesConnector())
  connectorRegistry.register(new HtxFuturesConnector({ proxyUrl }))
  connectorRegistry.register(new WeexFuturesConnector({ proxyUrl }))
  connectorRegistry.register(new BingxFuturesConnector({ proxyUrl }))
  // Gate.io: blocked from Vercel hnd1, needs VPS proxy
  connectorRegistry.register(new GateioFuturesConnector({ proxyUrl }))
  connectorRegistry.register(new XtFuturesConnector())
  connectorRegistry.register(new LbankFuturesConnector())
  connectorRegistry.register(new BlofinFuturesConnector())

  // New CEX Connectors
  connectorRegistry.register(new BtccFuturesConnector({ proxyUrl }))
  connectorRegistry.register(new BitunixFuturesConnector())
  connectorRegistry.register(new BitfinexFuturesConnector())
  connectorRegistry.register(new ToobitFuturesConnector())
  connectorRegistry.register(new EtoroSpotConnector())
  connectorRegistry.register(new BitgetSpotConnectorNew())
  connectorRegistry.register(new BinanceSpotConnectorNew({ proxyUrl }))

  // DEX Connectors
  connectorRegistry.register(new HyperliquidPerpConnector())
  connectorRegistry.register(new DydxPerpConnector({ proxyUrl }))
  connectorRegistry.register(new GmxPerpConnector())
  connectorRegistry.register(new GainsPerpConnector())
  connectorRegistry.register(new KwentaPerpConnector())
  connectorRegistry.register(new MuxPerpConnector())
  connectorRegistry.register(new AevoPerpConnector())
  connectorRegistry.register(new JupiterPerpsPerpConnector())
  connectorRegistry.register(new DriftPerpConnector())

  // Web3 Connectors
  connectorRegistry.register(new OkxWeb3Connector())
  connectorRegistry.register(new BinanceWeb3Connector())
  connectorRegistry.register(new Web3BotConnector())
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
  // 'binance_spot', — PERMANENTLY REMOVED (2026-03-14): repeatedly hangs 45-76min, blocks entire pipeline
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

function createLegacyConnector(platform: GranularPlatform): AnyConnector | null {
  switch (platform) {
    case 'binance_futures':
      return new BinanceFuturesConnector()
    // binance_spot: PERMANENTLY REMOVED (2026-03-14) - repeatedly hangs 45-76min, blocks entire pipeline
    case 'bybit':
      return new BybitConnector()
    case 'bitget_futures':
      return new BitgetFuturesConnector()
    case 'bitget_spot':
      return new BitgetSpotConnector()
    case 'okx':
      return new OKXConnector()
    case 'mexc':
      return new MEXCConnector()
    case 'kucoin':
      return null // DEAD: APIs 404 since 2026-03
    case 'hyperliquid':
      return new HyperliquidConnector()
    case 'coinex':
      return new CoinExConnector()
    default:
      return null
  }
}

/** Get list of platforms with implemented legacy connectors */
export function getAvailablePlatforms(): GranularPlatform[] {
  return [...IMPLEMENTED_PLATFORMS]
}

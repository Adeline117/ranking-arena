/**
 * Connector Registry
 * Central registry for all platform connectors.
 */

import type { PlatformConnector } from './types'
import type { Platform } from '@/lib/types/trading-platform'
import { BinanceFuturesConnector } from './binance-futures'

// Connector instances (singleton per platform)
const connectors = new Map<Platform, PlatformConnector>()

/**
 * Get or create a connector for the specified platform.
 * Returns null if no connector is implemented for the platform.
 */
export function getConnector(platform: Platform): PlatformConnector | null {
  if (connectors.has(platform)) {
    return connectors.get(platform)!
  }

  const connector = createConnector(platform)
  if (connector) {
    connectors.set(platform, connector)
  }
  return connector
}

function createConnector(platform: Platform): PlatformConnector | null {
  switch (platform) {
    case 'binance_futures':
      return new BinanceFuturesConnector()
    // Phase 2: Add more connectors here
    // case 'bybit':
    //   return new BybitConnector()
    // case 'bitget_futures':
    //   return new BitgetFuturesConnector()
    default:
      return null
  }
}

/** Get list of platforms with implemented connectors */
export function getAvailablePlatforms(): Platform[] {
  return ['binance_futures']
  // Phase 2: Add more as implemented
}

export { type PlatformConnector } from './types'
export { BinanceFuturesConnector } from './binance-futures'

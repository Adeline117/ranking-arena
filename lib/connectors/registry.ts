/**
 * Connector registry: provides connector instances for each platform.
 * Connectors are singletons within the process lifetime.
 */

import type { Platform, PlatformConnector } from '@/lib/types/leaderboard';
import { BinanceFuturesConnector } from './binance-futures';

const connectorInstances = new Map<Platform, PlatformConnector>();

/**
 * Get or create the connector for a given platform.
 * Returns null if the platform connector is not yet implemented.
 */
export function getConnector(platform: Platform): PlatformConnector | null {
  if (connectorInstances.has(platform)) {
    return connectorInstances.get(platform)!;
  }

  const connector = createConnector(platform);
  if (connector) {
    connectorInstances.set(platform, connector);
  }
  return connector;
}

/**
 * List all platforms that have an implemented connector.
 */
export function getAvailablePlatforms(): Platform[] {
  return IMPLEMENTED_PLATFORMS;
}

// ============================================
// Connector Factory
// ============================================

/**
 * Platforms with implemented connectors.
 * Add new platforms here as their connectors are built.
 */
const IMPLEMENTED_PLATFORMS: Platform[] = [
  'binance_futures',
  // 'binance_spot',     // TODO
  // 'binance_web3',     // TODO
  // 'bybit',            // TODO
  // 'bitget_futures',   // TODO
  // 'bitget_spot',      // TODO
  // 'mexc',             // TODO
  // 'coinex',           // TODO
  // 'okx',              // TODO
  // 'okx_wallet',       // TODO
  // 'kucoin',           // TODO
  // 'gmx',              // TODO
  // 'dydx',             // TODO
  // 'hyperliquid',      // TODO
  // 'bitmart',          // TODO
  // 'phemex',           // TODO
  // 'htx',              // TODO
  // 'weex',             // TODO
];

function createConnector(platform: Platform): PlatformConnector | null {
  switch (platform) {
    case 'binance_futures':
      return new BinanceFuturesConnector();
    // Add new connectors here:
    // case 'bybit':
    //   return new BybitConnector();
    default:
      return null;
  }
}

/**
 * Connector registry: provides connector instances for each platform.
 * Connectors are singletons within the process lifetime.
 */

import type { Platform, PlatformConnector } from '@/lib/types/leaderboard';
import { BinanceFuturesConnector } from './binance-futures';
import { BinanceSpotConnector } from './binance-spot';
import { BybitConnector } from './bybit';
import { BitgetFuturesConnector } from './bitget-futures';
import { OKXConnector } from './okx';
import { MEXCConnector } from './mexc';
import { KuCoinConnector } from './kucoin';
import { HyperliquidConnector } from './hyperliquid';
import { CoinExConnector } from './coinex';
import { BitgetSpotConnector } from './bitget-spot';

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
 */
const IMPLEMENTED_PLATFORMS: Platform[] = [
  'binance_futures',
  'binance_spot',
  'bybit',
  'bitget_futures',
  'bitget_spot',
  'okx',
  'mexc',
  'kucoin',
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
];

function createConnector(platform: Platform): PlatformConnector | null {
  switch (platform) {
    case 'binance_futures':
      return new BinanceFuturesConnector();
    case 'binance_spot':
      return new BinanceSpotConnector();
    case 'bybit':
      return new BybitConnector();
    case 'bitget_futures':
      return new BitgetFuturesConnector();
    case 'okx':
      return new OKXConnector();
    case 'mexc':
      return new MEXCConnector();
    case 'kucoin':
      return new KuCoinConnector();
    case 'hyperliquid':
      return new HyperliquidConnector();
    case 'coinex':
      return new CoinExConnector();
    case 'bitget_spot':
      return new BitgetSpotConnector();
    default:
      return null;
  }
}

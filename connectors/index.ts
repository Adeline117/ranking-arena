/**
 * Connector Registry
 * Central registry for all platform connectors
 */

import type { IConnector, Platform, MarketType } from './base/types';
import { BinanceFuturesConnector, BinanceSpotConnector, BinanceWeb3Connector } from './binance';
import { BybitConnector } from './bybit';
import { MexcConnector } from './mexc';
import { CoinexConnector } from './coinex';
import { OkxConnector, OkxWalletConnector } from './okx';
import { KucoinConnector } from './kucoin';
import { BitmartConnector } from './bitmart';
import { PhemexConnector } from './phemex';
import { HtxConnector } from './htx';
import { WeexConnector } from './weex';
import { GmxConnector } from './gmx';
import { DydxConnector } from './dydx';
import { HyperliquidConnector } from './hyperliquid';
import { GateioConnector } from './gateio';
import { BlofinConnector } from './blofin';
import { NansenConnector } from './nansen';
import { DuneConnector, DuneGmxConnector, DuneHyperliquidConnector, DuneUniswapConnector, DuneDefiConnector } from './dune';

export type ConnectorKey = `${Platform}:${MarketType}`;

const CONNECTOR_MAP: Record<string, () => IConnector> = {
  'binance:futures': () => new BinanceFuturesConnector(),
  'binance:spot': () => new BinanceSpotConnector(),
  'binance:web3': () => new BinanceWeb3Connector(),
  'bybit:futures': () => new BybitConnector(),
  // 'bitget:futures': PERMANENTLY REMOVED (2026-03-18) - VPS scraper repeatedly hangs 44+ min (6th stuck), blocks pipeline
  // 'bitget:spot': PERMANENTLY REMOVED (2026-03-18) - no public API exists (all endpoints 404)
  'mexc:futures': () => new MexcConnector(),
  'coinex:futures': () => new CoinexConnector(),
  'okx:futures': () => new OkxConnector(),
  'okx_wallet:web3': () => new OkxWalletConnector(),
  'kucoin:futures': () => new KucoinConnector(),
  'bitmart:futures': () => new BitmartConnector(),
  'phemex:futures': () => new PhemexConnector(),
  'htx:futures': () => new HtxConnector(),
  'weex:futures': () => new WeexConnector(),
  'gateio:futures': () => new GateioConnector(),
  'blofin:futures': () => new BlofinConnector(),
  'gmx:perp': () => new GmxConnector(),
  'dydx:perp': () => new DydxConnector(),
  'hyperliquid:perp': () => new HyperliquidConnector(),
  'nansen:enrichment': () => new NansenConnector(),
  'dune:enrichment': () => new DuneConnector(),
  // Dune on-chain leaderboards
  'dune_gmx:perp': () => new DuneGmxConnector(),
  'dune_hyperliquid:perp': () => new DuneHyperliquidConnector(),
  'dune_uniswap:spot': () => new DuneUniswapConnector(),
  'dune_defi:web3': () => new DuneDefiConnector(),
};

/**
 * Get a connector instance for a platform/market_type combination
 */
export function getConnector(platform: Platform, market_type: MarketType): IConnector | null {
  const key = `${platform}:${market_type}`;
  const factory = CONNECTOR_MAP[key];
  return factory ? factory() : null;
}

/**
 * Get all available connector keys
 */
export function getAllConnectorKeys(): ConnectorKey[] {
  return Object.keys(CONNECTOR_MAP) as ConnectorKey[];
}

/**
 * Get all ranking-capable connectors (excludes enrichment sources)
 */
export function getRankingConnectorKeys(): ConnectorKey[] {
  return getAllConnectorKeys().filter(key => !key.endsWith(':enrichment'));
}

/**
 * Get connectors for a specific platform
 */
export function getConnectorsForPlatform(platform: Platform): IConnector[] {
  return getAllConnectorKeys()
    .filter(key => key.startsWith(`${platform}:`))
    .map(key => {
      const [p, m] = key.split(':') as [Platform, MarketType];
      return getConnector(p, m)!;
    })
    .filter(Boolean);
}

// Re-export types
export type { IConnector, Platform, MarketType, Window } from './base/types';
export * from './base/types';

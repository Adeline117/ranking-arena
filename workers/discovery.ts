/* eslint-disable no-console */
/**
 * Source Discovery Module
 *
 * Automatically discovers and validates leaderboard endpoints for each platform.
 * Generates/updates sources/<platform>.json configuration files.
 *
 * Usage:
 *   npx tsx workers/discovery.ts
 *   # Or for a specific platform:
 *   npx tsx workers/discovery.ts --platform=binance
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getConnector } from '../connectors';
import type { Platform, MarketType, Window, SourceConfig } from '../connectors/base/types';

const SOURCES_DIR = join(__dirname, '..', 'sources');

// ============================================
// Platform Discovery Config
// ============================================

interface PlatformDiscoveryMeta {
  platform: Platform;
  market_type: MarketType;
  leaderboard_url: string;
  profile_url_template: string;
  api_endpoints: string[];
  windows: Window[];
  roi_sort_supported: boolean;
  roi_sort_method: 'query_param' | 'route' | 'ui_state' | 'not_supported';
}

const PLATFORM_META: PlatformDiscoveryMeta[] = [
  {
    platform: 'binance',
    market_type: 'futures',
    leaderboard_url: 'https://www.binance.com/en/copy-trading',
    profile_url_template: 'https://www.binance.com/en/copy-trading/lead-details/{trader_key}',
    api_endpoints: [
      'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
      'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance',
      'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'binance',
    market_type: 'spot',
    leaderboard_url: 'https://www.binance.com/en/copy-trading/spot',
    profile_url_template: 'https://www.binance.com/en/copy-trading/lead-details/{trader_key}?type=spot',
    api_endpoints: [
      'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'binance',
    market_type: 'web3',
    leaderboard_url: 'https://www.binance.com/en/web3-wallet',
    profile_url_template: '',
    api_endpoints: [
      'https://www.binance.com/bapi/composite/v1/friendly/marketing-campaign/copy-trade/rank-list',
    ],
    windows: ['7d', '30d'],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
  {
    platform: 'bybit',
    market_type: 'futures',
    leaderboard_url: 'https://www.bybit.com/copyTrading/traderRanking',
    profile_url_template: 'https://www.bybit.com/copyTrading/trade-center/detail?leaderMark={trader_key}',
    api_endpoints: [
      'https://api2.bybit.com/fapi/beehive/public/v2/common/leader/list',
      'https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail',
      'https://api2.bybit.com/fapi/beehive/public/v1/common/leader/performance',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'bitget',
    market_type: 'futures',
    leaderboard_url: 'https://www.bitget.com/copy-trading',
    profile_url_template: 'https://www.bitget.com/copy-trading/trader/detail/{trader_key}',
    api_endpoints: [
      'https://www.bitget.com/v1/trigger/trace/queryCopyTraderList',
      'https://www.bitget.com/v1/trigger/trace/queryTraderDetail',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'bitget',
    market_type: 'spot',
    leaderboard_url: 'https://www.bitget.com/copy-trading/spot',
    profile_url_template: 'https://www.bitget.com/copy-trading/trader/detail/{trader_key}?type=spot',
    api_endpoints: [
      'https://www.bitget.com/v1/trigger/trace/queryCopyTraderList',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'mexc',
    market_type: 'futures',
    leaderboard_url: 'https://www.mexc.com/copy-trading',
    profile_url_template: 'https://www.mexc.com/copy-trading/trader/{trader_key}',
    api_endpoints: [
      'https://www.mexc.com/api/platform/copy-trade/trader/list',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'coinex',
    market_type: 'futures',
    leaderboard_url: 'https://www.coinex.com/copy-trading',
    profile_url_template: 'https://www.coinex.com/copy-trading/trader/{trader_key}',
    api_endpoints: [
      'https://www.coinex.com/res/copy-trading/traders',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'okx',
    market_type: 'futures',
    leaderboard_url: 'https://www.okx.com/copy-trading/leaderboard',
    profile_url_template: 'https://www.okx.com/copy-trading/trader/{trader_key}',
    api_endpoints: [
      'https://www.okx.com/priapi/v5/ecotrade/public/leader-board',
      'https://www.okx.com/priapi/v5/ecotrade/public/trader/detail',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'okx_wallet',
    market_type: 'web3',
    leaderboard_url: 'https://www.okx.com/web3/dex/leaderboard',
    profile_url_template: '',
    api_endpoints: [
      'https://www.okx.com/priapi/v5/wallet/public/leader-board',
    ],
    windows: ['7d', '30d'],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
  {
    platform: 'kucoin',
    market_type: 'futures',
    leaderboard_url: 'https://www.kucoin.com/copy-trading',
    profile_url_template: 'https://www.kucoin.com/copy-trading/leader/{trader_key}',
    api_endpoints: [
      'https://www.kucoin.com/_api/copy-trade/leader/ranking',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'bitmart',
    market_type: 'futures',
    leaderboard_url: 'https://www.bitmart.com/copy-trading',
    profile_url_template: 'https://www.bitmart.com/copy-trading/trader/{trader_key}',
    api_endpoints: [
      'https://www.bitmart.com/api/copy-trading/v1/public/trader/list',
    ],
    windows: ['7d', '30d'],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
  {
    platform: 'phemex',
    market_type: 'futures',
    leaderboard_url: 'https://phemex.com/copy-trading',
    profile_url_template: 'https://phemex.com/copy-trading/leader/{trader_key}',
    api_endpoints: [
      'https://phemex.com/api/copy-trading/public/leader/ranking',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'htx',
    market_type: 'futures',
    leaderboard_url: 'https://www.htx.com/copy-trading',
    profile_url_template: 'https://www.htx.com/copy-trading/trader/{trader_key}',
    api_endpoints: [
      'https://www.htx.com/v1/copy-trading/public/trader/list',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: true,
    roi_sort_method: 'query_param',
  },
  {
    platform: 'weex',
    market_type: 'futures',
    leaderboard_url: 'https://www.weex.com/copy-trading',
    profile_url_template: 'https://www.weex.com/copy-trading/trader/{trader_key}',
    api_endpoints: [
      'https://www.weex.com/api/copy-trade/public/trader/ranking',
    ],
    windows: ['7d', '30d'],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
  {
    platform: 'gmx',
    market_type: 'perp',
    leaderboard_url: 'https://app.gmx.io/#/leaderboard',
    profile_url_template: 'https://app.gmx.io/#/actions/{trader_key}',
    api_endpoints: [
      'https://subgraph.satsuma-prod.com/3b2ced13c8d9/gmx/synthetics-arbitrum-stats/api',
      'https://arbitrum-api.gmxinfra.io/leaderboard/positions',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
  {
    platform: 'dydx',
    market_type: 'perp',
    leaderboard_url: 'https://dydx.exchange/leaderboard',
    profile_url_template: 'https://dydx.exchange/portfolio/{trader_key}',
    api_endpoints: [
      'https://indexer.dydx.trade/v4/leaderboard',
      'https://indexer.dydx.trade/v4/addresses/{trader_key}',
    ],
    windows: ['7d', '30d', '90d'],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
  {
    platform: 'hyperliquid',
    market_type: 'perp',
    leaderboard_url: 'https://app.hyperliquid.xyz/leaderboard',
    profile_url_template: 'https://app.hyperliquid.xyz/@{trader_key}',
    api_endpoints: [
      'https://api.hyperliquid.xyz/info',
    ],
    windows: ['7d', '30d'],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
  {
    platform: 'nansen',
    market_type: 'enrichment',
    leaderboard_url: 'https://app.nansen.ai',
    profile_url_template: 'https://app.nansen.ai/wallet/{trader_key}',
    api_endpoints: [],
    windows: [],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
  {
    platform: 'dune',
    market_type: 'enrichment',
    leaderboard_url: 'https://dune.com',
    profile_url_template: 'https://dune.com/search?q={trader_key}',
    api_endpoints: [
      'https://api.dune.com/api/v1/query/{query_id}/results',
    ],
    windows: [],
    roi_sort_supported: false,
    roi_sort_method: 'not_supported',
  },
];

// ============================================
// Field Maps per Platform
// ============================================

const FIELD_MAPS: Record<string, Record<string, string>> = {
  'binance:futures': {
    roi_pct: 'roi', pnl_usd: 'pnl', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown', trades_count: 'tradeCount',
    followers: 'followerCount', copiers: 'copierCount',
    sharpe_ratio: 'sharpeRatio', aum: 'totalMarginBalance',
  },
  'binance:spot': {
    roi_pct: 'roi', pnl_usd: 'pnl', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown', trades_count: 'tradeCount',
    followers: 'followerCount', copiers: 'copierCount', aum: 'totalAsset',
  },
  'binance:web3': {
    roi_pct: 'roi', pnl_usd: 'pnl', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown',
  },
  'bybit:futures': {
    roi_pct: 'roi', pnl_usd: 'pnl', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown', trades_count: 'totalOrder',
    followers: 'followerNum', copiers: 'copierNum',
    sharpe_ratio: 'sharpeRatio', aum: 'aum',
  },
  'bitget:futures': {
    roi_pct: 'roi', pnl_usd: 'profit', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown', trades_count: 'totalOrder',
    followers: 'followerCount', copiers: 'copierCount', aum: 'totalAssets',
  },
  'bitget:spot': {
    roi_pct: 'roi', pnl_usd: 'profit', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown', followers: 'followerCount',
  },
  'mexc:futures': {
    roi_pct: 'roi', pnl_usd: 'pnl', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown', followers: 'followerCount',
    copiers: 'copierCount',
  },
  'coinex:futures': {
    roi_pct: 'roi', pnl_usd: 'pnl', win_rate: 'win_rate',
    max_drawdown: 'max_drawdown', followers: 'follower_count',
    copiers: 'copier_count',
  },
  'okx:futures': {
    roi_pct: 'pnlRatio', pnl_usd: 'pnl', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown', trades_count: 'orderCount',
    followers: 'followerCount', copiers: 'copierCount',
  },
  'okx_wallet:web3': {
    roi_pct: 'pnlRatio', pnl_usd: 'pnl', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown',
  },
  'kucoin:futures': {
    roi_pct: 'roi', pnl_usd: 'pnl', win_rate: 'winRate',
    max_drawdown: 'maxDrawdown', followers: 'followerCount',
    copiers: 'copierCount',
  },
  'gmx:perp': {
    roi_pct: '_calculated', pnl_usd: 'totalPnlAfterFees',
    trades_count: 'totalTrades',
  },
  'dydx:perp': {
    roi_pct: 'pnlPercent', pnl_usd: 'totalPnl',
  },
  'hyperliquid:perp': {
    roi_pct: 'roi', pnl_usd: 'pnl', aum: 'accountValue',
  },
};

// ============================================
// Discovery Runner
// ============================================

async function discoverPlatform(meta: PlatformDiscoveryMeta): Promise<SourceConfig> {
  const key = `${meta.platform}:${meta.market_type}`;
  console.log(`[Discovery] Testing ${key}...`);

  const connector = getConnector(meta.platform, meta.market_type);
  const proofs: SourceConfig['proof'] = [];

  // Try to discover leaderboard
  if (connector && meta.windows.length > 0) {
    const testWindow = meta.windows[0];
    try {
      const result = await connector.discoverLeaderboard(testWindow, 5);
      if (result.success && result.data && result.data.length > 0) {
        const sample = result.data[0];
        proofs.push({
          url: meta.leaderboard_url,
          request_path: meta.api_endpoints[0] || meta.leaderboard_url,
          method: 'POST',
          response_fields_sample: {
            trader_key: sample.trader_key,
            display_name: sample.display_name ? '[REDACTED]' : null,
            metrics_available: Object.keys(sample.metrics).filter(k => sample.metrics[k as keyof typeof sample.metrics] != null),
            rank: sample.rank,
          },
          discovered_at: new Date().toISOString(),
        });
        console.log(`  ✓ Leaderboard: ${result.data.length} traders found`);
      } else {
        console.log(`  ✗ Leaderboard: ${result.error || 'empty'}`);
        proofs.push({
          url: meta.leaderboard_url,
          request_path: meta.api_endpoints[0] || meta.leaderboard_url,
          method: 'GET',
          response_fields_sample: { error: result.error || 'No data returned' },
          discovered_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.log(`  ✗ Leaderboard error: ${(error as Error).message}`);
      proofs.push({
        url: meta.leaderboard_url,
        request_path: meta.api_endpoints[0] || '',
        method: 'GET',
        response_fields_sample: { error: (error as Error).message },
        discovered_at: new Date().toISOString(),
      });
    }
  }

  // Build source config
  const fieldMap = FIELD_MAPS[key] || {};

  const config: SourceConfig = {
    platform: meta.platform,
    market_type: meta.market_type,
    leaderboard_endpoints: meta.api_endpoints
      .filter((_, i) => i === 0)
      .map(url => ({
        url,
        method: 'POST' as const,
        headers: { 'Origin': new URL(meta.leaderboard_url).origin },
        pagination: { type: 'offset' as const, page_size: 20, max_pages: 5, param_name: 'pageNumber' },
        response_path: 'data.list',
      })),
    profile_endpoints: meta.api_endpoints
      .filter((_, i) => i > 0)
      .map(url => ({
        url,
        method: 'POST' as const,
        headers: { 'Origin': new URL(meta.leaderboard_url).origin },
      })),
    window_support: meta.windows,
    rate_limit_hint: {
      rpm: meta.platform === 'binance' || meta.platform === 'bybit' ? 20 : 10,
      concurrent: 2,
      delay_ms: 3000,
    },
    field_map: fieldMap,
    roi_sort_supported: meta.roi_sort_supported,
    roi_sort_method: meta.roi_sort_method,
    proof: proofs,
  };

  return config;
}

async function runDiscovery(targetPlatform?: string): Promise<void> {
  mkdirSync(SOURCES_DIR, { recursive: true });

  const targets = targetPlatform
    ? PLATFORM_META.filter(m => m.platform === targetPlatform)
    : PLATFORM_META;

  console.log(`[Discovery] Running for ${targets.length} platform configurations...`);
  console.log('');

  for (const meta of targets) {
    try {
      const config = await discoverPlatform(meta);
      const filename = meta.market_type === 'futures' || meta.market_type === 'perp' || meta.market_type === 'enrichment'
        ? `${meta.platform}.json`
        : `${meta.platform}_${meta.market_type}.json`;

      const filepath = join(SOURCES_DIR, filename);

      // If file already exists with same platform+market_type, merge
      let existingConfigs: SourceConfig[] = [];
      try {
        const raw = readFileSync(filepath, 'utf-8');
        const existing = JSON.parse(raw);
        existingConfigs = Array.isArray(existing) ? existing : [existing];
        // Remove old entry for same market_type
        existingConfigs = existingConfigs.filter(c => c.market_type !== meta.market_type);
      } catch {
        // File doesn't exist yet
      }

      const allConfigs = [...existingConfigs, config];
      const output = allConfigs.length === 1 ? allConfigs[0] : allConfigs;

      writeFileSync(filepath, JSON.stringify(output, null, 2) + '\n');
      console.log(`  → Saved to sources/${filename}`);
      console.log('');

      // Rate limit between platforms
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`  ✗ Error discovering ${meta.platform}:${meta.market_type}:`, error);
      console.log('');
    }
  }

  console.log('[Discovery] Complete!');
}

// ============================================
// CLI Entry Point
// ============================================

const platformArg = process.argv.find(a => a.startsWith('--platform='));
const targetPlatform = platformArg?.split('=')[1];

runDiscovery(targetPlatform).catch(err => {
  console.error('Discovery failed:', err);
  process.exit(1);
});

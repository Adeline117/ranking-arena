/**
 * Binance Web3 Wallet Connector
 *
 * Source: https://www.binance.com/en/web3-wallet
 * Note: Web3 wallet leaderboard has limited public data
 * Windows: 7D, 30D supported; 90D may not be available
 * ROI Sort: Not directly supported (platform default)
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.binance.com';

export class BinanceWeb3Connector extends BaseConnector {
  platform: Platform = 'binance';
  market_type: MarketType = 'web3';

  protected rate_limit = { rpm: 15, concurrent: 1, delay_ms: 4000 };

  async discoverLeaderboard(window: Window, limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const timeRange = window === '7d' ? 'WEEKLY' : window === '30d' ? 'MONTHLY' : 'QUARTER';
      const url = `${API_BASE}/bapi/composite/v1/friendly/marketing-campaign/copy-trade/rank-list`;

      const response = await this.postJSON<{ data: { list: Record<string, unknown>[] } }>(url, {
        pageNumber: 1,
        pageSize: Math.min(limit, 50),
        timeRange,
        tradeType: 'SPOT',
        walletType: 'WEB3',
      }, {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/en/web3-wallet`,
      });

      if (!response?.data?.list) {
        return this.success([], {
          source_url: url,
          platform_sorting: 'default',
          reason: 'Web3 wallet leaderboard returned empty or unavailable',
        }, { window_not_supported: window === '90d' });
      }

      const entries: LeaderboardEntry[] = response.data.list.map((item, idx) => ({
        trader_key: String(item.encryptedUid || item.uid || idx),
        display_name: (item.nickname as string) || null,
        avatar_url: (item.userPhotoUrl as string) || null,
        profile_url: null,
        rank: idx + 1,
        metrics: this.normalize(item, {}),
        raw: item,
      }));

      return this.success(entries, {
        source_url: url,
        platform_sorting: 'default',
        reason: 'Web3 wallet does not support ROI sort parameter',
      });
    } catch (error) {
      return this.failure(`Binance Web3 leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    return this.failure('Binance Web3 individual profiles not publicly accessible');
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('Binance Web3 individual snapshots not publicly accessible');
  }

  async fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([], { reason: 'Web3 timeseries not available' });
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi ?? raw.pnlRate),
      pnl_usd: this.parseNumber(raw.pnl),
      win_rate: this.parseNumber(raw.winRate),
      max_drawdown: this.parseNumber(raw.maxDrawdown ?? raw.mdd),
      trades_count: this.parseNumber(raw.tradeCount) as number | null,
      followers: this.parseNumber(raw.followerCount) as number | null,
      copiers: null,
      sharpe_ratio: null,
      aum: null,
    };
  }
}

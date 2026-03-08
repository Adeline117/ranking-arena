/**
 * Gate.io Copy Trading Connector
 *
 * Source: https://www.gate.io/copy_trading
 * API: Copy trading public endpoints
 * Windows: 7D, 30D, 90D
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.gate.io';

export class GateioConnector extends BaseConnector {
  platform: Platform = 'gateio';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 20, concurrent: 2, delay_ms: 3000 };

  async discoverLeaderboard(window: Window, limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const periodMap: Record<Window, string> = { '7d': '7d', '30d': '30d', '90d': '90d' };
      const period = periodMap[window] || '30d';

      // Try VPS scraper first
      let response = await this.fetchViaVPS<{ data: { list: Record<string, unknown>[] } }>('/gateio/leaderboard', {
        page: 1,
        pageSize: Math.min(limit, 100),
        period,
      });

      // Fallback to direct API if VPS failed
      const apiUrl = `${API_BASE}/api/v1/copy/leaders?page=1&limit=${Math.min(limit, 100)}&period=${period}&sort=roi`;
      if (!response) {
        response = await this.fetchJSON<{ data: { list: Record<string, unknown>[] } }>(apiUrl, {
          headers: {
            'Origin': API_BASE,
            'Referer': `${API_BASE}/copy_trading`,
          },
        });
      }

      if (!response?.data?.list) {
        return this.success([], {
          source_url: apiUrl,
          platform_sorting: 'default',
          reason: 'Gate.io leaderboard may not be publicly accessible or endpoint changed',
        });
      }

      const entries: LeaderboardEntry[] = response.data.list.map((item, idx) => ({
        trader_key: String(item.uid || item.user_id || ''),
        display_name: (item.nickname as string) || (item.nick_name as string) || null,
        avatar_url: (item.avatar as string) || null,
        profile_url: `${API_BASE}/copy_trading/trader/${item.uid || item.user_id}`,
        rank: idx + 1,
        metrics: this.normalize(item),
        raw: item,
      }));

      entries.sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: url,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`Gate.io leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(_trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    return this.failure('Gate.io individual profiles require further endpoint discovery');
  }

  async fetchTraderSnapshot(_trader_key: string, _window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('Gate.io snapshots require further endpoint discovery');
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([]);
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi ?? raw.roi_rate ?? raw.profit_rate),
      pnl_usd: this.parseNumber(raw.pnl ?? raw.profit ?? raw.total_profit),
      win_rate: this.parseNumber(raw.win_rate ?? raw.winRate),
      max_drawdown: this.parseNumber(raw.max_drawdown ?? raw.maxDrawdown),
      trades_count: this.parseNumber(raw.trade_count ?? raw.total_trades) as number | null,
      followers: this.parseNumber(raw.followers ?? raw.follower_count) as number | null,
      copiers: this.parseNumber(raw.copiers ?? raw.copier_count) as number | null,
      sharpe_ratio: null,
      aum: this.parseNumber(raw.aum ?? raw.total_assets) as number | null,
    };
  }
}

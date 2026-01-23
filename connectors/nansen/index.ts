/**
 * Nansen Data Enrichment Connector
 *
 * Source: https://app.nansen.ai
 * Purpose: Wallet labeling, smart money tracking, on-chain intelligence
 * Note: Most Nansen data requires paid access. This connector uses
 *       publicly available label data and portfolio insights only.
 * Windows: N/A (enrichment data, not time-windowed rankings)
 * ROI Sort: N/A (enrichment only)
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const NANSEN_PUBLIC = 'https://app.nansen.ai';

export class NansenConnector extends BaseConnector {
  platform: Platform = 'nansen';
  market_type: MarketType = 'enrichment';

  protected rate_limit = { rpm: 5, concurrent: 1, delay_ms: 10000 };

  async discoverLeaderboard(_window: Window, _limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    // Nansen is not a leaderboard source; it's an enrichment source
    return this.success([], {
      reason: 'Nansen is an enrichment source, not a leaderboard. Use for wallet labeling and smart money data.',
    }, {
      reason: 'Nansen requires paid API access for most data. Only public labels available.',
    });
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      // Attempt to fetch public wallet labels from Nansen
      // Note: Most Nansen data requires authentication
      const url = `${NANSEN_PUBLIC}/api/public/wallet/${trader_key}/labels`;

      try {
        const response = await this.fetchJSON<{ labels: string[]; name?: string }>(url);

        return this.success<CanonicalProfile>({
          platform: 'nansen',
          market_type: 'enrichment',
          trader_key,
          display_name: response?.name || null,
          avatar_url: null,
          bio: null,
          tags: response?.labels || ['unknown'],
          profile_url: `${NANSEN_PUBLIC}/wallet/${trader_key}`,
          followers: null,
          copiers: null,
          aum: null,
          provenance: this.buildProvenance(url, {
            reason: 'Public label data only. Full data requires Nansen API key.',
          }),
        });
      } catch {
        // Nansen public endpoints may not be available
        return this.success<CanonicalProfile>({
          platform: 'nansen',
          market_type: 'enrichment',
          trader_key,
          display_name: null,
          avatar_url: null,
          bio: null,
          tags: [],
          profile_url: `${NANSEN_PUBLIC}/wallet/${trader_key}`,
          followers: null,
          copiers: null,
          aum: null,
          provenance: this.buildProvenance(url, {
            reason: 'Nansen public API not accessible. Set NANSEN_API_KEY for full access.',
          }),
        });
      }
    } catch (error) {
      return this.failure(`Nansen enrichment failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(_trader_key: string, _window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('Nansen is an enrichment source, not a performance snapshot source');
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([], { reason: 'Nansen timeseries requires paid API access' });
  }

  normalize(raw: Record<string, unknown>): Partial<SnapshotMetrics> {
    return {
      roi_pct: null,
      pnl_usd: null,
      win_rate: null,
      max_drawdown: null,
      trades_count: null,
      followers: null,
      copiers: null,
      sharpe_ratio: null,
      aum: this.parseNumber(raw.portfolioValue ?? raw.balance),
    };
  }
}

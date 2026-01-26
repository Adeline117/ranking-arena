/**
 * Dune Analytics Connectors
 *
 * Source: https://dune.com
 * Purpose: On-chain analytics via Dune API queries
 *
 * This file exports:
 * - DuneConnector: Original enrichment connector for wallet data
 * - DuneGmxConnector: GMX (Arbitrum) perpetual traders leaderboard
 * - DuneHyperliquidConnector: Hyperliquid perpetual traders leaderboard
 * - DuneUniswapConnector: Uniswap DEX spot traders leaderboard
 * - DuneDefiConnector: General DeFi wallet activity leaderboard
 *
 * Required: DUNE_API_KEY environment variable for all connectors
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

// Re-export leaderboard connectors
export { DuneGmxConnector } from './gmx';
export { DuneHyperliquidConnector } from './hyperliquid';
export { DuneUniswapConnector } from './uniswap';
export { DuneDefiConnector } from './defi';

const DUNE_API = 'https://api.dune.com/api/v1';
const DUNE_APP = 'https://dune.com';

// Pre-built public query IDs for trader analytics
// These are example queries - actual query IDs should be discovered/created
const QUERIES = {
  // Top PnL traders on major perp DEXs
  TOP_PERP_TRADERS: '3123456', // placeholder - real query ID needed
  // Wallet activity summary
  WALLET_SUMMARY: '3123457', // placeholder
};

export class DuneConnector extends BaseConnector {
  platform: Platform = 'dune';
  market_type: MarketType = 'enrichment';

  protected rate_limit = { rpm: 5, concurrent: 1, delay_ms: 12000 };

  private get apiKey(): string | null {
    return process.env.DUNE_API_KEY || null;
  }

  async discoverLeaderboard(_window: Window, _limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    // Dune can provide leaderboard data via pre-built queries
    if (!this.apiKey) {
      return this.success([], {
        reason: 'Dune API key not configured. Set DUNE_API_KEY env var for enrichment data.',
      });
    }

    try {
      const url = `${DUNE_API}/query/${QUERIES.TOP_PERP_TRADERS}/results`;
      const response = await this.fetchJSON<DuneQueryResult>(url, {
        headers: { 'x-dune-api-key': this.apiKey },
      });

      if (!response?.result?.rows) return this.success([]);

      const entries: LeaderboardEntry[] = response.result.rows.map((row, idx) => ({
        trader_key: String(row.address || row.wallet).toLowerCase(),
        display_name: (row.label as string) || null,
        avatar_url: null,
        profile_url: `${DUNE_APP}/queries/${QUERIES.TOP_PERP_TRADERS}`,
        rank: idx + 1,
        metrics: this.normalize(row as Record<string, unknown>, {}),
        raw: row as Record<string, unknown>,
      }));

      return this.success(entries, {
        source_url: url,
        platform_sorting: 'default',
        reason: 'Dune query results, sorted by query default',
      });
    } catch (error) {
      return this.failure(`Dune leaderboard query failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    if (!this.apiKey) {
      return this.success<CanonicalProfile>({
        platform: 'dune',
        market_type: 'enrichment',
        trader_key,
        display_name: null,
        avatar_url: null,
        bio: null,
        tags: ['on-chain'],
        profile_url: `${DUNE_APP}/search?q=${trader_key}`,
        followers: null,
        copiers: null,
        aum: null,
        provenance: this.buildProvenance(DUNE_APP, {
          reason: 'DUNE_API_KEY not set. Cannot fetch enrichment data.',
        }),
      });
    }

    try {
      // Execute wallet summary query with address parameter
      const url = `${DUNE_API}/query/${QUERIES.WALLET_SUMMARY}/results?params.address=${trader_key}`;
      const response = await this.fetchJSON<DuneQueryResult>(url, {
        headers: { 'x-dune-api-key': this.apiKey },
      });

      const row = response?.result?.rows?.[0];
      return this.success<CanonicalProfile>({
        platform: 'dune',
        market_type: 'enrichment',
        trader_key,
        display_name: row ? (row.label as string) || null : null,
        avatar_url: null,
        bio: null,
        tags: row?.labels ? (row.labels as string[]) : ['on-chain'],
        profile_url: `${DUNE_APP}/search?q=${trader_key}`,
        followers: null,
        copiers: null,
        aum: row ? this.parseNumber(row.total_value) as number | null : null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Dune profile enrichment failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(_trader_key: string, _window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('Dune is an enrichment source. Use platform-specific connectors for snapshots.');
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([], { reason: 'Dune timeseries requires custom query execution' });
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi ?? raw.pnl_pct ?? raw.return_pct),
      pnl_usd: this.parseNumber(raw.pnl ?? raw.total_pnl ?? raw.profit),
      win_rate: this.parseNumber(raw.win_rate ?? raw.winRate),
      max_drawdown: this.parseNumber(raw.max_drawdown),
      trades_count: this.parseNumber(raw.total_trades ?? raw.trade_count) as number | null,
      followers: null,
      copiers: null,
      sharpe_ratio: null,
      aum: this.parseNumber(raw.total_value ?? raw.portfolio_value),
    };
  }
}

interface DuneQueryResult {
  result: {
    rows: Record<string, unknown>[];
    metadata: {
      column_names: string[];
      row_count: number;
    };
  };
}

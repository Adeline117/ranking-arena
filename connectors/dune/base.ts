/**
 * Base class for Dune Analytics connectors
 * Provides shared functionality for querying Dune API
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform,
  MarketType,
  Window,
  ConnectorResult,
  LeaderboardEntry,
  CanonicalProfile,
  CanonicalSnapshot,
  CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const DUNE_API = 'https://api.dune.com/api/v1';
const DUNE_APP = 'https://dune.com';

export interface DuneQueryResult {
  execution_id: string;
  state: 'QUERY_STATE_PENDING' | 'QUERY_STATE_EXECUTING' | 'QUERY_STATE_COMPLETED' | 'QUERY_STATE_FAILED';
  result?: {
    rows: Record<string, unknown>[];
    metadata: {
      column_names: string[];
      row_count: number;
    };
  };
  error?: string;
}

export interface DuneLeaderboardRow {
  address: string;
  total_pnl?: number;
  roi_pct?: number;
  trade_count?: number;
  win_rate?: number;
  total_volume?: number;
  pnl_range?: number;
  protocols_used?: number;
  swap_count?: number;
  tokens_traded?: number;
  tx_count?: number;
  label?: string;
}

export abstract class DuneBaseConnector extends BaseConnector {
  abstract platform: Platform;
  abstract market_type: MarketType;
  abstract queryId: string;
  abstract queryName: string;

  protected rate_limit = { rpm: 5, concurrent: 1, delay_ms: 12000 };

  protected get apiKey(): string | null {
    return process.env.DUNE_API_KEY || null;
  }

  /**
   * Execute a Dune query and wait for results
   */
  protected async executeQuery(
    queryId: string,
    params?: Record<string, string>
  ): Promise<DuneQueryResult | null> {
    if (!this.apiKey) {
      console.warn(`[${this.platform}] DUNE_API_KEY not set`);
      return null;
    }

    try {
      // First, execute the query
      let executeUrl = `${DUNE_API}/query/${queryId}/execute`;
      if (params) {
        const searchParams = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
          searchParams.set(`params.${key}`, value);
        });
        executeUrl += `?${searchParams.toString()}`;
      }

      const executeResponse = await this.postJSON<{ execution_id: string }>(
        executeUrl,
        {},
        { 'x-dune-api-key': this.apiKey }
      );

      if (!executeResponse?.execution_id) {
        console.error(`[${this.platform}] Failed to execute query ${queryId}`);
        return null;
      }

      // Poll for results (max 60 seconds)
      const maxWait = 60000;
      const pollInterval = 3000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        const statusUrl = `${DUNE_API}/execution/${executeResponse.execution_id}/status`;
        const statusResponse = await this.fetchJSON<DuneQueryResult>(statusUrl, {
          headers: { 'x-dune-api-key': this.apiKey },
        });

        if (statusResponse?.state === 'QUERY_STATE_COMPLETED') {
          // Fetch full results
          const resultsUrl = `${DUNE_API}/execution/${executeResponse.execution_id}/results`;
          return this.fetchJSON<DuneQueryResult>(resultsUrl, {
            headers: { 'x-dune-api-key': this.apiKey },
          });
        }

        if (statusResponse?.state === 'QUERY_STATE_FAILED') {
          console.error(`[${this.platform}] Query failed:`, statusResponse.error);
          return null;
        }

        await this.sleep(pollInterval);
      }

      console.error(`[${this.platform}] Query timed out after ${maxWait}ms`);
      return null;
    } catch (error) {
      console.error(`[${this.platform}] Query execution error:`, error);
      return null;
    }
  }

  /**
   * Fetch cached results for a query (faster, uses last execution)
   */
  protected async fetchCachedResults(queryId: string): Promise<DuneQueryResult | null> {
    if (!this.apiKey) {
      console.warn(`[${this.platform}] DUNE_API_KEY not set`);
      return null;
    }

    try {
      const url = `${DUNE_API}/query/${queryId}/results`;
      return this.fetchJSON<DuneQueryResult>(url, {
        headers: { 'x-dune-api-key': this.apiKey },
      });
    } catch (error) {
      console.error(`[${this.platform}] Fetch cached results error:`, error);
      return null;
    }
  }

  async discoverLeaderboard(
    window: Window,
    limit = 100
  ): Promise<ConnectorResult<LeaderboardEntry[]>> {
    if (!this.apiKey) {
      return this.success([], {
        reason: `DUNE_API_KEY not set. Cannot fetch ${this.queryName} leaderboard.`,
      });
    }

    try {
      // Try cached results first (faster, doesn't count against query limit)
      let result = await this.fetchCachedResults(this.queryId);

      // If no cached results or stale, execute fresh query
      if (!result?.result?.rows?.length) {
        result = await this.executeQuery(this.queryId, {
          days: this.windowToDays(window),
        });
      }

      if (!result?.result?.rows) {
        return this.success([]);
      }

      const entries: LeaderboardEntry[] = result.result.rows
        .slice(0, limit)
        .map((row, idx) => this.rowToLeaderboardEntry(row as DuneLeaderboardRow, idx + 1));

      return this.success(entries, {
        source_url: `${DUNE_APP}/queries/${this.queryId}`,
        platform_sorting: 'default',
        platform_window: window,
        reason: `${this.queryName} via Dune Analytics`,
      });
    } catch (error) {
      return this.failure(`${this.queryName} leaderboard fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    // Dune provides minimal profile data - just the address
    return this.success<CanonicalProfile>({
      platform: this.platform,
      market_type: this.market_type,
      trader_key,
      display_name: this.formatAddress(trader_key),
      avatar_url: null,
      bio: null,
      tags: ['on-chain', this.queryName.toLowerCase()],
      profile_url: this.getExplorerUrl(trader_key),
      followers: null,
      copiers: null,
      aum: null,
      provenance: this.buildProvenance(this.getExplorerUrl(trader_key)),
    });
  }

  async fetchTraderSnapshot(
    trader_key: string,
    window: Window
  ): Promise<ConnectorResult<CanonicalSnapshot>> {
    if (!this.apiKey) {
      return this.failure('DUNE_API_KEY not set');
    }

    // For individual trader snapshots, we need a parameterized query
    // This is a simplified implementation - real queries would need trader-specific queries
    try {
      const result = await this.fetchCachedResults(this.queryId);
      if (!result?.result?.rows) {
        return this.failure('No data available');
      }

      const row = result.result.rows.find(
        r => (r.address as string)?.toLowerCase() === trader_key.toLowerCase()
      ) as DuneLeaderboardRow | undefined;

      if (!row) {
        return this.failure(`Trader ${trader_key} not found in leaderboard`);
      }

      const metrics = this.normalize(row as unknown as Record<string, unknown>);

      return this.success<CanonicalSnapshot>({
        platform: this.platform,
        market_type: this.market_type,
        trader_key,
        window,
        as_of_ts: new Date().toISOString(),
        metrics: metrics as SnapshotMetrics,
        quality_flags: this.buildQualityFlags(metrics),
        provenance: this.buildProvenance(`${DUNE_APP}/queries/${this.queryId}`),
      });
    } catch (error) {
      return this.failure(`Snapshot fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    // Dune doesn't provide timeseries by default - would need custom queries
    return this.success([], { reason: 'Dune timeseries requires custom query execution' });
  }

  /**
   * Convert a Dune row to a leaderboard entry
   * Override in subclasses for platform-specific mapping
   */
  protected abstract rowToLeaderboardEntry(
    row: DuneLeaderboardRow,
    rank: number
  ): LeaderboardEntry;

  /**
   * Get explorer URL for an address
   */
  protected abstract getExplorerUrl(address: string): string;

  /**
   * Format an address for display
   */
  protected formatAddress(address: string): string {
    if (!address) return 'Unknown';
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  /**
   * Convert window to days for query parameter
   */
  protected windowToDays(window: Window): string {
    switch (window) {
      case '7d': return '7';
      case '30d': return '30';
      case '90d': return '90';
    }
  }
}

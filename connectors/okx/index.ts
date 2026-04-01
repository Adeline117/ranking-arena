/**
 * OKX Copy Trading Connector
 *
 * Source: https://www.okx.com/copy-trading/leaderboard
 * API: Public copy trade endpoints
 * Windows: 7D, 30D, 90D
 * ROI Sort: Supported via sortField=pnlRatio
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.okx.com';
const LIST_API = `${API_BASE}/priapi/v5/ecotrade/public/leader-board`;
const PROFILE_API = `${API_BASE}/priapi/v5/ecotrade/public/trader/detail`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
};

export class OkxConnector extends BaseConnector {
  platform: Platform = 'okx';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 30, concurrent: 3, delay_ms: 2000 }; // Emergency fix 2026-04-01: increase speed

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 20;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        const params = new URLSearchParams({
          pageNo: String(page),
          pageSize: String(pageSize),
          sortField: 'pnlRatio',
          sortType: 'desc',
          period: WINDOW_MAP[window],
        });

        const response = await this.fetchJSON<OkxListResponse>(
          `${LIST_API}?${params.toString()}`,
          {
            headers: {
              'Referer': `${API_BASE}/copy-trading/leaderboard`,
              'Origin': API_BASE,
            },
          }
        );

        if (!response?.data?.ranks) break;

        for (const item of response.data.ranks) {
          entries.push({
            trader_key: item.uniqueName || item.traderUid,
            display_name: item.nickName || null,
            avatar_url: item.avatarUrl || null,
            profile_url: `${API_BASE}/copy-trading/trader/${item.uniqueName}`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
          });
        }

        if (response.data.ranks.length < pageSize) break;
        await this.sleep(this.getRandomDelay(3000, 5000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: LIST_API,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`OKX leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${PROFILE_API}?uniqueName=${trader_key}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (!response?.data) return this.failure('Profile not found');
      const d = response.data;

      return this.success<CanonicalProfile>({
        platform: 'okx',
        market_type: 'futures',
        trader_key,
        display_name: (d.nickName as string) || null,
        avatar_url: (d.avatarUrl as string) || null,
        bio: (d.introduction as string) || null,
        tags: [],
        profile_url: `${API_BASE}/copy-trading/trader/${trader_key}`,
        followers: this.parseNumber(d.followerCount) as number | null,
        copiers: this.parseNumber(d.copierCount) as number | null,
        aum: this.parseNumber(d.aum) as number | null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const url = `${PROFILE_API}?uniqueName=${trader_key}&period=${WINDOW_MAP[window]}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (!response?.data) return this.failure('Snapshot not found');
      const metrics = this.normalize(response.data, FIELD_MAP);

      return this.success<CanonicalSnapshot>({
        platform: 'okx',
        market_type: 'futures',
        trader_key,
        window,
        as_of_ts: new Date().toISOString(),
        metrics: metrics as SnapshotMetrics,
        quality_flags: this.buildQualityFlags(metrics),
        provenance: this.buildProvenance(url, { platform_sorting: 'roi_desc', platform_window: window }),
      });
    } catch (error) {
      return this.failure(`Snapshot fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    try {
      // OKX provides weekly PnL data via public API
      const url = `https://www.okx.com/api/v5/copytrading/public-weekly-pnl?instType=SWAP&uniqueCode=${trader_key}`;
      const response = await this.fetchJSON<{ code: string; data: Array<{ beginTs: string; pnl: string; pnlRatio: string }> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (response?.code !== '0' || !response?.data?.length) return this.success([]);

      // Sort by time ascending
      const sorted = [...response.data].sort((a, b) => Number(a.beginTs) - Number(b.beginTs));

      let cumulativeRoi = 0;
      const points = sorted.map(p => {
        const weekRoi = p.pnlRatio ? Number(p.pnlRatio) * 100 : 0;
        cumulativeRoi += weekRoi;
        return {
          ts: new Date(Number(p.beginTs)).toISOString(),
          value: cumulativeRoi,
          pnl: p.pnl ? Number(p.pnl) : 0,
        };
      });

      return this.success<CanonicalTimeseries[]>([{
        platform: 'okx',
        market_type: 'futures',
        trader_key,
        series_type: 'equity_curve',
        as_of_ts: new Date().toISOString(),
        data: points,
        provenance: this.buildProvenance(url),
      }]);
    } catch (error) {
      return this.success([], { reason: `OKX timeseries failed: ${(error as Error).message}` });
    }
  }

  normalize(raw: Record<string, unknown>, field_map: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'pnlRatio'] ?? raw.roi),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'pnl']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'winRate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'maxDrawdown']),
      trades_count: this.parseNumber(raw[field_map['trades_count'] || 'orderCount']) as number | null,
      followers: this.parseNumber(raw[field_map['followers'] || 'followerCount']) as number | null,
      copiers: this.parseNumber(raw[field_map['copiers'] || 'copierCount']) as number | null,
      sharpe_ratio: this.parseNumber(raw.sharpeRatio),
      aum: this.parseNumber(raw.aum),
    };
  }
}

export class OkxWalletConnector extends BaseConnector {
  platform: Platform = 'okx_wallet';
  market_type: MarketType = 'web3';

  protected rate_limit = { rpm: 10, concurrent: 1, delay_ms: 5000 };

  async discoverLeaderboard(window: Window, limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const params = new URLSearchParams({
        period: WINDOW_MAP[window],
        pageNo: '1',
        pageSize: String(Math.min(limit, 50)),
        chainId: '0',
      });

      const url = `${API_BASE}/priapi/v5/wallet/public/leader-board?${params.toString()}`;
      const response = await this.fetchJSON<{ data: { ranks: Record<string, unknown>[] } }>(url, {
        headers: { 'Origin': API_BASE, 'Referer': `${API_BASE}/web3/dex/leaderboard` },
      });

      if (!response?.data?.ranks) {
        return this.success([], {
          source_url: url,
          platform_sorting: 'default',
          reason: 'OKX Wallet leaderboard may not be publicly accessible',
        });
      }

      const entries: LeaderboardEntry[] = response.data.ranks.map((item, idx) => ({
        trader_key: String(item.address || item.uid || idx),
        display_name: (item.nickName as string) || (item.address as string)?.slice(0, 10) || null,
        avatar_url: (item.avatarUrl as string) || null,
        profile_url: null,
        rank: idx + 1,
        metrics: this.normalize(item, {}),
        raw: item,
      }));

      return this.success(entries, {
        source_url: url,
        platform_sorting: 'default',
        reason: 'OKX Wallet uses default sort',
      });
    } catch (error) {
      return this.failure(`OKX Wallet leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(_trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    return this.failure('OKX Wallet profiles not publicly accessible via API');
  }

  async fetchTraderSnapshot(_trader_key: string, _window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('OKX Wallet snapshots not publicly accessible');
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([]);
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.pnlRatio ?? raw.roi),
      pnl_usd: this.parseNumber(raw.pnl),
      win_rate: this.parseNumber(raw.winRate),
      max_drawdown: this.parseNumber(raw.maxDrawdown),
      trades_count: null,
      followers: null,
      copiers: null,
      sharpe_ratio: null,
      aum: null,
    };
  }
}

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'pnlRatio',
  pnl_usd: 'pnl',
  win_rate: 'winRate',
  max_drawdown: 'maxDrawdown',
  trades_count: 'orderCount',
  followers: 'followerCount',
  copiers: 'copierCount',
};

interface OkxListResponse {
  data: { ranks: OkxTraderItem[] };
}

interface OkxTraderItem {
  uniqueName: string;
  traderUid: string;
  nickName: string;
  avatarUrl: string;
  pnlRatio: number;
}

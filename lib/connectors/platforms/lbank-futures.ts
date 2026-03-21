/**
 * LBank Futures Connector
 *
 * LBank has copy trading but NO public leaderboard API.
 * This connector is a stub for potential web scraping implementation.
 *
 * Key notes:
 * - trader_key is LBank UID
 * - Has copy trading at lbank.com/copy-trading
 * - Requires web scraping for data access
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { LbankFuturesLeaderboardResponseSchema } from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface LBankLeaderboardEntry {
  uid?: string
  nickname?: string
  avatar?: string
  roi?: number
  pnl?: number
  followers?: number
  winRate?: number
}

export class LbankFuturesConnector extends BaseConnector {
  readonly platform = 'lbank' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'lbank',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 4,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['No public API', 'Requires Puppeteer scraping', 'Copy trading platform'],
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Origin': 'https://www.lbank.com',
      'Referer': 'https://www.lbank.com/copy-trading',
    }
  }

  async discoverLeaderboard(window: Window, limit = 2000, _offset = 0): Promise<DiscoverResult> {
    try {
      // Try VPS scraper first
      let _rawLb = await this.fetchViaVPS<{ data?: { list?: LBankLeaderboardEntry[] } }>('/lbank/leaderboard', {
        page: 1,
        pageSize: limit,
      });

      // Fallback to direct API if VPS failed (likely won't work without Puppeteer)
      if (!_rawLb) {
        _rawLb = await this.request<{ data?: { list?: LBankLeaderboardEntry[] } }>(
          `https://www.lbank.com/api/copy-trading/leaders?limit=${limit}`,
          { method: 'GET', headers: this.getHeaders() }
        );
      }

      const data = warnValidate(LbankFuturesLeaderboardResponseSchema, _rawLb, 'lbank-futures/leaderboard')

      const list = data?.data?.list || []
      const traders: TraderSource[] = list.map((item) => ({
        platform: 'lbank',
        market_type: 'futures' as const,
        trader_key: String(item.uid || ''),
        display_name: item.nickname || null,
        profile_url: `https://www.lbank.com/copy-trading/trader/${item.uid}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: item as Record<string, unknown>,
      }))

      return { traders, total_available: traders.length, window, fetched_at: new Date().toISOString() }
    } catch {
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const profile: TraderProfile = {
      platform: 'lbank',
      market_type: 'futures',
      trader_key: traderKey,
      display_name: null,
      avatar_url: null,
      bio: null,
      tags: ['copy-trading'],
      profile_url: `https://www.lbank.com/copy-trading/trader/${traderKey}`,
      followers: null,
      copiers: null,
      aum: null,
      updated_at: new Date().toISOString(),
      last_enriched_at: new Date().toISOString(),
      provenance: {
        source_platform: 'lbank',
        acquisition_method: 'scrape',
        fetched_at: new Date().toISOString(),
        source_url: null,
        scraper_version: '1.0.0',
      },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    return {
      metrics: this.emptyMetrics(),
      quality_flags: {
        missing_fields: ['all'],
        non_standard_fields: {},
        window_native: false,
        notes: ['LBank has no public leaderboard API'],
      },
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return { trader_key: raw.uid, display_name: raw.nickname }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

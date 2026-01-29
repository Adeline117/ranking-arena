/**
 * XT.com Futures Connector
 *
 * Uses XT.com's internal endpoints for copy trading leaderboard data.
 * Note: XT.com does NOT have a public leaderboard API - this connector
 * attempts to use internal endpoints and may require Puppeteer scraping.
 *
 * Key notes:
 * - trader_key is XT.com UID
 * - Has both spot and futures copy trading
 * - May require web scraping for full functionality
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface XTLeaderboardEntry {
  uid?: string
  nickname?: string
  avatar?: string
  roi?: number
  pnl?: number
  followerCount?: number
  copyCount?: number
  winRate?: number
  maxDrawdown?: number
  aum?: number
}

export class XtFuturesConnector extends BaseConnector {
  readonly platform = 'xt' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'xt',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 4, // Requires web scraping
    rate_limit: { rpm: 15, concurrency: 2 },
    notes: ['No public API', 'Requires Puppeteer scraping', 'Copy trading platform'],
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.xt.com',
      'Referer': 'https://www.xt.com/en/copy-trading/futures',
    }
  }

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' }
    const period = periodMap[window] || '30'

    try {
      // Attempt to use XT internal API endpoint (may not work without Puppeteer)
      const data = await this.request<{ data?: { list?: XTLeaderboardEntry[] } }>(
        `https://www.xt.com/sapi/v1/copy-trading/leader/list?page=1&pageSize=${limit}&period=${period}&sortBy=roi`,
        { method: 'GET', headers: this.getHeaders() }
      )

      const list = data?.data?.list || []
      const traders: TraderSource[] = list.map((item) => ({
        platform: 'xt',
        market_type: 'futures' as const,
        trader_key: String(item.uid || ''),
        display_name: item.nickname || null,
        profile_url: `https://www.xt.com/en/copy-trading/trader/${item.uid}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: item as Record<string, unknown>,
      }))

      return { traders, total_available: traders.length, window, fetched_at: new Date().toISOString() }
    } catch {
      // XT.com likely requires Puppeteer scraping
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const data = await this.request<{ data?: XTLeaderboardEntry }>(
        `https://www.xt.com/sapi/v1/copy-trading/leader/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )

      const info = data?.data
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'xt',
        market_type: 'futures',
        trader_key: traderKey,
        display_name: info.nickname || null,
        avatar_url: info.avatar || null,
        bio: null,
        tags: ['copy-trading', 'futures'],
        profile_url: `https://www.xt.com/en/copy-trading/trader/${traderKey}`,
        followers: this.num(info.followerCount),
        copiers: this.num(info.copyCount),
        aum: this.num(info.aum),
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'xt',
          acquisition_method: 'api',
          fetched_at: new Date().toISOString(),
          source_url: null,
          scraper_version: '1.0.0',
        },
      }
      return { profile, fetched_at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' }
    const period = periodMap[window] || '30'

    try {
      const data = await this.request<{ data?: XTLeaderboardEntry }>(
        `https://www.xt.com/sapi/v1/copy-trading/leader/${traderKey}?period=${period}`,
        { method: 'GET', headers: this.getHeaders() }
      )

      const info = data?.data
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: true, notes: ['Trader not found or API blocked'] },
          fetched_at: new Date().toISOString(),
        }
      }

      const metrics: SnapshotMetrics = {
        roi: this.num(info.roi),
        pnl: this.num(info.pnl),
        win_rate: this.num(info.winRate),
        max_drawdown: this.num(info.maxDrawdown),
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: null,
        followers: this.num(info.followerCount),
        copiers: this.num(info.copyCount),
        aum: this.num(info.aum),
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const quality_flags: QualityFlags = {
        missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count'],
        non_standard_fields: {},
        window_native: true,
        notes: ['XT.com copy trading platform'],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      trader_key: raw.uid,
      display_name: raw.nickname,
      roi: this.num(raw.roi),
      pnl: this.num(raw.pnl),
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return isNaN(n) ? null : n
  }
}

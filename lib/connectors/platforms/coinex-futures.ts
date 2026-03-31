/**
 * CoinEx Futures Connector
 *
 * Uses CoinEx's copy trading API.
 * Note: CoinEx does NOT support 90d window.
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  CoinexFuturesLeaderboardResponseSchema,
  CoinexFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class CoinexFuturesConnector extends BaseConnector {
  readonly platform = 'coinex' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'coinex',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],  // No 90d
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: ['No 90d window', 'No timeseries endpoint'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, offset = 0): Promise<DiscoverResult> {
    // CoinEx does not support 90d
    if (window === '90d') {
      return {
        traders: [], total_available: 0, window,
        fetched_at: new Date().toISOString(),
      }
    }

    // Auto-paginate: fetch all pages (CoinEx has ~176 traders across 4 pages)
    // CoinEx API rejects limit > 50 with "Invalid Parameter" — use 50 per page
    const pageSize = 50
    const allTraders: TraderSource[] = []
    let currentPage = Math.floor(offset / pageSize) + 1
    const maxPages = Math.ceil(limit / pageSize)

    while (currentPage <= maxPages) {
      let _rawLb: Record<string, unknown>
      try {
        _rawLb = await this.request<Record<string, unknown>>(
          `https://www.coinex.com/res/copy-trading/public/traders?page=${currentPage}&limit=${pageSize}&sort_by=roi&period=${window}`,
          { method: 'GET' }
        )
      } catch {
        // Fallback: VPS Playwright scraper (CoinEx has geo-blocking)
        const vpsData = await this.fetchViaVPS<Record<string, unknown>>('/coinex/leaderboard', {
          period: window, page: String(currentPage), limit: String(pageSize),
        })
        if (!vpsData) throw new Error('Both direct API and VPS scraper failed for coinex')
        _rawLb = vpsData
      }
      const data = warnValidate(CoinexFuturesLeaderboardResponseSchema, _rawLb, 'coinex-futures/leaderboard')
      const list = data?.data?.items || data?.data?.data || []
      if (!Array.isArray(list) || list.length === 0) break

      const traders: TraderSource[] = list.map((item: Record<string, unknown>) => ({
        platform: 'coinex' as const, market_type: 'futures' as const,
        trader_key: String(item.trader_id || ''),
        display_name: (item.nickname as string) || null,
        profile_url: `https://www.coinex.com/copy-trading/trader/${item.trader_id}`,
        discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
        is_active: true, raw: item as Record<string, unknown>,
      }))
      allTraders.push(...traders)

      // Check if there are more pages
      const hasNext = data?.data?.has_next ?? (list.length >= pageSize)
      if (!hasNext || allTraders.length >= limit) break
      currentPage++
      await new Promise(r => setTimeout(r, 500)) // Rate limit between pages
    }

    return { traders: allTraders, total_available: allTraders.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://www.coinex.com/res/copy-trading/trader/${traderKey}/detail`,
      { method: 'GET' }
    )
    const data = warnValidate(CoinexFuturesDetailResponseSchema, _rawProfile, 'coinex-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'coinex', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickname as string) || null,
      avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://www.coinex.com/copy-trading/trader/${traderKey}`,
      followers: this.num(info.followers), copiers: this.num(info.copiers),
      aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'coinex', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    if (window === '90d') {
      // Platform does not support 90d
      const metrics: SnapshotMetrics = {
        roi: null, pnl: null, win_rate: null, max_drawdown: null,
        sharpe_ratio: null, sortino_ratio: null, trades_count: null,
        followers: null, copiers: null, aum: null, platform_rank: null,
        arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
      }
      const quality_flags: QualityFlags = {
        missing_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown'],
        non_standard_fields: {},
        window_native: false,
        notes: ['CoinEx does not provide 90-day window data'],
      }
      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    }

    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://www.coinex.com/res/copy-trading/trader/${traderKey}/detail?period=${window}`,
      { method: 'GET' }
    )
    const data = warnValidate(CoinexFuturesDetailResponseSchema, _rawSnap, 'coinex-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.num(info.roi), pnl: this.num(info.profit),
      win_rate: this.num(info.win_rate), max_drawdown: this.num(info.max_drawdown),
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: this.num(info.followers), copiers: this.num(info.copiers),
      aum: null, platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count', 'aum'],
      non_standard_fields: {}, window_native: true, notes: [],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw CoinEx leaderboard entry.
   * Raw fields: trader_id/traderId/uid, nick_name/nickName/nickname,
   * roi/roi_rate/return_rate/profit_rate (decimal), profit_amount/pnl/profit,
   * win_rate/winRate/winning_rate (decimal), max_drawdown/maxDrawdown/mdd,
   * follower_count/followerCount/copier_num, avatar/avatar_url.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const rawRoi = this.num(raw.roi ?? raw.roi_rate ?? raw.return_rate ?? raw.profit_rate)
    const roi = rawRoi != null ? (Math.abs(rawRoi) <= 1 ? rawRoi * 100 : rawRoi) : null
    const rawWr = this.num(raw.win_rate ?? raw.winRate ?? raw.winning_rate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
    const rawMdd = this.num(raw.max_drawdown ?? raw.maxDrawdown ?? raw.mdd)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    return {
      trader_key: raw.trader_id ?? raw.traderId ?? raw.uid ?? raw.id ?? null,
      display_name: raw.nick_name ?? raw.nickName ?? raw.nickname ?? raw.account_name ?? raw.name ?? null,
      avatar_url: raw.avatar ?? raw.avatar_url ?? null,
      roi,
      pnl: this.num(raw.profit_amount ?? raw.pnl ?? raw.profit ?? raw.total_pnl_amount),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: null,
      followers: this.num(raw.follower_count ?? raw.followerCount ?? raw.copier_num ?? raw.cur_follower_num),
      copiers: null,
      aum: null,
      sharpe_ratio: null,
      platform_rank: null,
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return !Number.isFinite(n) ? null : n
  }
}

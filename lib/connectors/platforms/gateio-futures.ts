/**
 * Gate.io Futures Connector
 *
 * Uses Gate.io's copy trading API endpoints.
 *
 * Key notes:
 * - trader_key is Gate.io UID
 * - Has copy trading / strategy bot features
 * - May require API exploration for exact endpoints
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  GateioFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface GateioLeaderboardEntry {
  uid?: string
  nickname?: string
  avatar?: string
  roi?: number
  pnl?: number
  followers?: number
  copiers?: number
  winRate?: number
  maxDrawdown?: number
}

export class GateioFuturesConnector extends BaseConnector {
  readonly platform = 'gateio' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'gateio',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['Strategy bot platform', 'Copy trading features', 'May require web scraping'],
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.gate.io',
      'Referer': 'https://www.gate.io/strategybot',
    }
  }

  /**
   * Discover traders from Gate.io copy-trading leaderboard.
   * Uses /apiw/v2/copy/leader/list (correct endpoint matching inline fetcher).
   * Gate.io profit_rate is a RATIO (9.54 = 954%), converted in normalize().
   * Pagination: 50/page, up to 500 traders.
   */
  async discoverLeaderboard(window: Window, limit = 750, _offset = 0): Promise<DiscoverResult> {
    // Gate.io only supports cycle=month currently (week/quarter return "system error" since ~2026-03)
    // Use month for all windows — better than no data
    const cycle = 'month'
    const pageSize = 50
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `https://www.gate.com/apiw/v2/copy/leader/list?page=${page}&page_size=${pageSize}&order_by=profit_rate&cycle=${cycle}`
        let data: Record<string, unknown>
        try {
          data = await this.request<Record<string, unknown>>(url, {
            method: 'GET',
            headers: this.getHeaders(),
          })
        } catch {
          // Fallback: VPS Playwright scraper (bypasses WAF)
          const vpsData = await this.fetchViaVPS<Record<string, unknown>>('/gateio/leaderboard', {
            cycle, page: String(page),
          })
          if (!vpsData) throw new Error('Both direct API and VPS scraper failed for gateio')
          data = vpsData
        }

        // Handle multiple response formats
        const list: Array<Record<string, unknown>> = (
          (data as Record<string, unknown>)?.list ??
          ((data as Record<string, unknown>)?.data as Record<string, unknown>)?.list ??
          (data as Record<string, unknown>)?.items ??
          []
        ) as Array<Record<string, unknown>>

        if (!list.length) break

        for (const item of list) {
          const id = String(item.leader_id ?? item.user_id ?? item.uid ?? item.trader_id ?? item.id ?? item.userId ?? '')
          if (!id) continue
          const userInfo = item.user_info as Record<string, unknown> | undefined
          allTraders.push({
            platform: 'gateio' as const,
            market_type: 'futures' as const,
            trader_key: id,
            display_name: (userInfo?.nickname ?? userInfo?.nick ?? item.nickname ?? item.name ?? item.nickName ?? null) as string | null,
            profile_url: `https://www.gate.io/strategybot/trader/${id}`,
            discovered_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            is_active: true,
            raw: item as Record<string, unknown>,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= limit) break
      } catch (err) {
        if (page === 1) throw err  // First page failure is fatal, not silenced
        break
      }
    }

    return { traders: allTraders.slice(0, limit), total_available: allTraders.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const _rawProfile = await this.request<{ data?: GateioLeaderboardEntry }>(
        `https://www.gate.io/api/v1/copy/leader/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(GateioFuturesDetailResponseSchema, _rawProfile, 'gateio-futures/profile')

      const info = data?.data
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'gateio',
        market_type: 'futures',
        trader_key: traderKey,
        display_name: info.nickname || null,
        avatar_url: info.avatar || null,
        bio: null,
        tags: ['strategy-bot', 'copy-trading'],
        profile_url: `https://www.gate.io/strategybot/trader/${traderKey}`,
        followers: this.num(info.followers),
        copiers: this.num(info.copiers),
        aum: null,
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'gateio',
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
    const periodMap: Record<Window, string> = { '7d': '7d', '30d': '30d', '90d': '90d' }
    const period = periodMap[window] || '30d'

    try {
      const _rawSnap = await this.request<{ data?: GateioLeaderboardEntry }>(
        `https://www.gate.io/api/v1/copy/leader/${traderKey}?period=${period}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(GateioFuturesDetailResponseSchema, _rawSnap, 'gateio-futures/snapshot')

      const info = data?.data
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: true, notes: ['Trader not found'] },
          fetched_at: new Date().toISOString(),
        }
      }

      const rawSharpe = this.num((info as Record<string, unknown>).sharp_ratio ?? (info as Record<string, unknown>).sharpRatio ?? (info as Record<string, unknown>).sharpe_ratio)
      const sharpe_ratio = rawSharpe != null ? Math.max(-20, Math.min(20, Math.round(rawSharpe * 100) / 100)) : null

      const metrics: SnapshotMetrics = {
        roi: this.num(info.roi),
        pnl: this.num(info.pnl),
        win_rate: this.num(info.winRate),
        max_drawdown: this.num(info.maxDrawdown),
        sharpe_ratio,
        sortino_ratio: null,
        trades_count: null,
        followers: this.num(info.followers),
        copiers: this.num(info.copiers),
        aum: null,
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const missingFields = ['sortino_ratio', 'trades_count', 'aum']
      if (sharpe_ratio == null) missingFields.unshift('sharpe_ratio')

      const quality_flags: QualityFlags = {
        missing_fields: missingFields,
        non_standard_fields: {},
        window_native: true,
        notes: ['Gate.io strategy bot platform'],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw Gate.io leaderboard entry.
   * IMPORTANT: Gate.io profit_rate is a RATIO (9.54 = 954%), multiply ×100.
   * Raw fields: leader_id/user_id/uid, user_info.nickname/nickname,
   * profit_rate/pnl_ratio/pl_ratio/roi (ratio), pnl/profit/totalPnl,
   * win_rate/winRate (decimal), max_drawdown/maxDrawdown,
   * curr_follow_num/follower_num/followers, user_info.avatar/avatar.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // profit_rate is ratio: 9.54 means 954%
    const rawProfitRate = this.num(
      raw.profit_rate ?? raw.pnl_ratio ?? raw.pl_ratio ?? raw.roi ?? raw.returnRate
    )
    const roi = rawProfitRate != null ? rawProfitRate * 100 : null

    const rawWr = this.num(raw.win_rate ?? raw.winRate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
    const rawMdd = this.num(raw.max_drawdown ?? raw.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    // Extract avatar from nested user_info or direct field
    const userInfo = raw.user_info as Record<string, unknown> | undefined
    const avatar = userInfo?.avatar ?? raw.avatar ?? raw.avatarUrl ?? raw.head_url ?? null

    return {
      trader_key: raw.leader_id ?? raw.user_id ?? raw.uid ?? raw.trader_id ?? raw.id ?? raw.userId ?? null,
      display_name: userInfo?.nickname ?? userInfo?.nick ?? raw.nickname ?? raw.name ?? raw.nickName ?? null,
      avatar_url: avatar,
      roi,
      pnl: this.num(raw.pnl ?? raw.profit ?? raw.totalPnl ?? raw.follow_profit),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: null,
      followers: this.num(raw.curr_follow_num ?? raw.follower_num ?? raw.followers ?? raw.followerCount),
      copiers: this.num(raw.copier_num ?? raw.copierCount),
      aum: null,
      sharpe_ratio: (() => {
        const s = this.num(raw.sharp_ratio ?? raw.sharpRatio ?? raw.sharpe_ratio)
        return s != null ? Math.max(-20, Math.min(20, Math.round(s * 100) / 100)) : null
      })(),
      platform_rank: null,
      // Extra: equity curve from leaderboard API (profit_list is array of daily ROI ratios)
      _profit_list: raw.profit_list,
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

/**
 * MEXC Futures Connector
 *
 * Uses MEXC's copy trading API.
 * Endpoint: futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { MexcFuturesLeaderboardResponseSchema, MexcFuturesDetailResponseSchema } from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const WINDOW_MAP: Record<Window, number> = { '7d': 1, '30d': 2, '90d': 3 }

export class MexcFuturesConnector extends BaseConnector {
  readonly platform = 'mexc' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'mexc',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: ['CF protected', 'No timeseries endpoint available'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, offset = 0): Promise<DiscoverResult> {
    // MEXC is CF-protected; VPS scraper opens a real browser per request.
    // Paginate: fetch 100 per page up to limit.
    const pageSize = 100
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []
    let totalAvailable: number | null = null

    for (let page = 1; page <= maxPages; page++) {
      let _rawLb: Record<string, unknown> | null = null
      const vpsData = await this.fetchViaVPS<Record<string, unknown>>('/mexc/leaderboard', {
        periodType: String(WINDOW_MAP[window]), pageSize: String(pageSize), page: String(page),
      }, 300000)
      if (vpsData) {
        _rawLb = vpsData
      } else {
        // Fallback: direct API (rarely works from datacenter IPs)
        try {
          _rawLb = await this.request<Record<string, unknown>>(
            `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list?page=${page}&pageSize=${pageSize}&sortField=yield&sortType=DESC&timeType=${WINDOW_MAP[window]}`,
            { method: 'GET' }
          )
        } catch {
          break // Direct API blocked, stop pagination
        }
      }

      if (!_rawLb) break

      const dataObj = (_rawLb.data ?? {}) as Record<string, unknown>
      const list = (dataObj?.list || dataObj?.comprehensives || dataObj?.resultList || []) as unknown[]
      if (dataObj?.total && totalAvailable == null) totalAvailable = Number(dataObj.total)

      if (list.length === 0) break

      for (const item of list) {
        allTraders.push({
          platform: 'mexc' as const,
          market_type: 'futures' as const,
          trader_key: String((item as Record<string, unknown>).uid || ''),
          display_name: ((item as Record<string, unknown>).nickname as string) || null,
          profile_url: `https://futures.mexc.com/copy-trading/trader/${(item as Record<string, unknown>).uid}`,
          discovered_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          is_active: true,
          raw: item as Record<string, unknown>,
        })
      }

      if (list.length < pageSize) break // Last page
    }

    return { traders: allTraders.slice(0, limit), total_available: totalAvailable, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/detail?uid=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(MexcFuturesDetailResponseSchema, _rawProfile, 'mexc-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'mexc', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickname as string) || null,
      avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://futures.mexc.com/copy-trading/trader/${traderKey}`,
      followers: this.num(info.followerCount), copiers: this.num(info.copyCount),
      aum: this.num(info.aum),
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'mexc', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/detail?uid=${traderKey}&timeType=${WINDOW_MAP[window]}`,
      { method: 'GET' }
    )
    const data = warnValidate(MexcFuturesDetailResponseSchema, _rawSnap, 'mexc-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.num(info.yield), pnl: this.num(info.pnl),
      win_rate: this.num(info.winRate), max_drawdown: this.num(info.maxRetrace),
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: this.num(info.followerCount), copiers: this.num(info.copyCount),
      aum: this.num(info.aum), platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count'],
      non_standard_fields: {}, window_native: true, notes: [],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    // MEXC does not provide public timeseries API
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw MEXC leaderboard entry.
   * Raw fields: uid, nickname/nickName, yield/totalRoi/pnlRate (ROI decimal),
   * pnl/totalPnl/profit, winRate, mdd/maxDrawdown, followerCount/copierCount,
   * avatar/avatarUrl/headImg.
   * Note: ROI in decimal format (0.5 = 50%), normalized via ×100 if ≤1.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const rawRoi = this.num(raw.yield ?? raw.roi ?? raw.totalRoi ?? raw.pnlRate)
    const roi = rawRoi != null ? (Math.abs(rawRoi) <= 1 ? rawRoi * 100 : rawRoi) : null
    const rawWr = this.num(raw.winRate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
    const rawMdd = this.num(raw.maxRetrace ?? raw.mdd ?? raw.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    return {
      trader_key: raw.uid ?? raw.traderId ?? raw.id ?? raw.userId ?? null,
      display_name: raw.nickname ?? raw.nickName ?? raw.name ?? raw.displayName ?? raw.traderName ?? null,
      avatar_url: raw.avatar ?? raw.avatarUrl ?? raw.headImg ?? null,
      roi,
      pnl: this.num(raw.pnl ?? raw.totalPnl ?? raw.profit),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: null,
      followers: this.num(raw.followerCount ?? raw.copierCount ?? raw.followers),
      copiers: null,
      aum: null,
      sharpe_ratio: null,
      platform_rank: null,
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

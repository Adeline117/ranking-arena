/**
 * HTX (formerly Huobi) Futures Connector
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { safeNumber, safeStr, safeMdd } from '../utils'
import { HtxFuturesLeaderboardResponseSchema, HtxFuturesDetailResponseSchema } from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class HtxFuturesConnector extends BaseConnector {
  readonly platform = 'htx' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'htx',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: ['Frequent API/DOM changes', 'CF protected', 'All 3 windows supported'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, offset = 0): Promise<DiscoverResult> {
    // /bapi/ endpoint returns 405 since ~2026-03. Use futures.htx.com ranking API instead.
    const pageSize = 50 // API max 50 per page
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []

    // Overall timeout guard: abort pagination if we're taking too long
    const startedAt = Date.now()
    const PAGE_TIMEOUT_MS = 25000 // 25s per page budget (leaves room for 3 windows in 300s limit)

    for (let page = Math.floor(offset / pageSize) + 1; page <= maxPages + Math.floor(offset / pageSize); page++) {
      // Bail out early if we're running close to budget
      if (Date.now() - startedAt > PAGE_TIMEOUT_MS * (page - Math.floor(offset / pageSize))) break

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
      let _rawLb: Record<string, unknown>
      try {
        _rawLb = await this.request<Record<string, unknown>>(
          `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=${pageSize}`,
          { method: 'GET', signal: controller.signal }
        )
      } catch {
        clearTimeout(timer)
        break // Skip remaining pages on timeout/error — return what we have
      }
      clearTimeout(timer)

      const data = warnValidate(HtxFuturesLeaderboardResponseSchema, _rawLb, 'htx-futures/leaderboard')
      // New endpoint returns { code: 200, data: { itemList: [...], totalPage, totalNum } }
      const list = data?.data?.itemList || data?.data?.list || []
      const items = Array.isArray(list) ? list : []

      for (const item of items) {
        allTraders.push({
          platform: 'htx' as const, market_type: 'futures' as const,
          trader_key: String((item as Record<string, unknown>).uid || ''),
          display_name: ((item as Record<string, unknown>).nickName as string) || null,
          profile_url: `https://www.htx.com/copy-trading/trader/${(item as Record<string, unknown>).uid}`,
          discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
          is_active: true, raw: item as Record<string, unknown>,
        })
      }

      if (items.length < pageSize) break // No more pages
      if (allTraders.length >= limit) break
    }

    return { traders: allTraders.slice(0, limit), total_available: null, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://www.htx.com/bapi/copy-trade/v1/public/trader/detail?uid=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(HtxFuturesDetailResponseSchema, _rawProfile, 'htx-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'htx', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickName as string) || null, avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://www.htx.com/copy-trading/trader/${traderKey}`,
      followers: this.num(info.followerCount), copiers: this.num(info.copyCount), aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'htx', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://www.htx.com/bapi/copy-trade/v1/public/trader/detail?uid=${traderKey}&period=${window}`,
      { method: 'GET' }
    )
    const data = warnValidate(HtxFuturesDetailResponseSchema, _rawSnap, 'htx-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.num(info.roi), pnl: this.num(info.pnl),
      win_rate: this.num(info.winRate), max_drawdown: this.num(info.maxDrawdown),
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: this.num(info.followerCount), copiers: this.num(info.copyCount),
      aum: null, platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count'],
      non_standard_fields: {}, window_native: true, notes: [],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw HTX leaderboard entry.
   * Raw fields: uid/userSign, nickName, profitRate90/totalProfitRate (90D ROI decimal),
   * profit90/copyProfit/cumulativePnl/profit (PnL), winRate (decimal 0-1), mdd (decimal),
   * copyUserNum, aum, profitList (cumulative return series).
   * Note: Period ROI computed from profitList in inline fetcher — not in normalize().
   * All values may be strings from API — use safeNumber for parseFloat.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const rawWr = safeNumber(raw.winRate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
    const maxDrawdown = safeMdd(raw.mdd ?? raw.maxDrawdown, safeNumber(raw.mdd ?? raw.maxDrawdown) != null && Math.abs(safeNumber(raw.mdd ?? raw.maxDrawdown)!) <= 1)

    return {
      trader_key: raw.uid ?? raw.userSign ?? null,
      display_name: safeStr(raw.nickName),
      avatar_url: safeStr(raw.avatar) || safeStr(raw.imgUrl) || null,
      roi: safeNumber(raw.roi ?? raw.profitRate90 ?? raw.totalProfitRate),
      pnl: safeNumber(raw.pnl ?? raw.profit90 ?? raw.cumulativePnl ?? raw.copyProfit ?? raw.profit),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: null,
      followers: safeNumber(raw.copyUserNum),
      copiers: null,
      aum: safeNumber(raw.aum),
      sharpe_ratio: (() => {
        const profitList = raw.profitList as string[] | number[] | undefined
        if (!Array.isArray(profitList) || profitList.length < 7) return null
        const values = profitList.map(Number).filter(n => !isNaN(n))
        if (values.length < 7) return null
        const returns = values.slice(1).map((v, i) => v - values[i])
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length
        const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
        if (std <= 0) return null
        const sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
        return Math.max(-20, Math.min(20, sharpe))
      })(),
      platform_rank: safeNumber(raw.no ?? raw.order ?? raw.rank),
      // Extra: equity curve from profitList (30-day daily cumulative returns)
      _profit_list: raw.profitList,
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return !Number.isFinite(n) ? null : n
  }
}

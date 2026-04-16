/**
 * CoinEx Futures Connector
 *
 * Uses CoinEx's copy trading API.
 * Note: CoinEx does NOT support 90d window.
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { safeNumber } from '../utils'
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
    has_timeseries: true,
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
    // Time budget: 60s total — prevents runaway pagination from blocking batch-fetch
    const DEADLINE_MS = Date.now() + 60_000
    const pageSize = 50
    const allTraders: TraderSource[] = []
    let currentPage = Math.floor(offset / pageSize) + 1
    const maxPages = Math.ceil(limit / pageSize)

    while (currentPage <= maxPages) {
      if (Date.now() > DEADLINE_MS) {
        this.logger.warn(`[coinex] 60s deadline exceeded at page ${currentPage}, returning ${allTraders.length} traders`)
        break
      }
      let _rawLb: Record<string, unknown>
      const apiUrl = `https://www.coinex.com/res/copy-trading/public/traders?page=${currentPage}&limit=${pageSize}&sort_by=roi&period=${window}`
      try {
        _rawLb = await this.request<Record<string, unknown>>(apiUrl, { method: 'GET' })
      } catch (err) {
        this.logger.debug('CoinEx direct API fallback:', err instanceof Error ? err.message : String(err))
        const vpsData = await this.proxyViaVPS<Record<string, unknown>>(apiUrl)
        if (!vpsData) throw new Error('Both direct API and VPS proxy failed for coinex')
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
    const profileUrl = `https://www.coinex.com/res/copy-trading/trader/${traderKey}/detail`
    let _rawProfile: Record<string, unknown>
    try {
      _rawProfile = await this.request<Record<string, unknown>>(profileUrl, { method: 'GET' })
    } catch (err) {
      this.logger.debug('CoinEx profile direct API fallback:', err instanceof Error ? err.message : String(err))
      const vpsData = await this.proxyViaVPS<Record<string, unknown>>(profileUrl)
      if (!vpsData) return null
      _rawProfile = vpsData
    }
    const data = warnValidate(CoinexFuturesDetailResponseSchema, _rawProfile, 'coinex-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'coinex', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickname as string) || null,
      avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://www.coinex.com/copy-trading/trader/${traderKey}`,
      followers: safeNumber(info.followers), copiers: safeNumber(info.copiers),
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

    const snapUrl = `https://www.coinex.com/res/copy-trading/trader/${traderKey}/detail?period=${window}`
    let _rawSnap: Record<string, unknown>
    try {
      _rawSnap = await this.request<Record<string, unknown>>(snapUrl, { method: 'GET' })
    } catch (err) {
      this.logger.debug('CoinEx snapshot direct API fallback:', err instanceof Error ? err.message : String(err))
      const vpsData = await this.proxyViaVPS<Record<string, unknown>>(snapUrl)
      if (!vpsData) return null
      _rawSnap = vpsData
    }
    const data = warnValidate(CoinexFuturesDetailResponseSchema, _rawSnap, 'coinex-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: safeNumber(info.roi), pnl: safeNumber(info.profit),
      win_rate: safeNumber(info.win_rate), max_drawdown: safeNumber(info.max_drawdown),
      sharpe_ratio: null, sortino_ratio: null,
      trades_count: safeNumber(info.trade_count ?? info.tradeCount ?? info.trades_count),
      followers: safeNumber(info.followers), copiers: safeNumber(info.copiers),
      aum: null, platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio', 'aum'],
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
    // CoinEx returns profit_rate/winning_rate/mdd as decimals (1.0 = 100%)
    // Always multiply by 100 to get percentage values
    const rawRoi = safeNumber(raw.roi ?? raw.roi_rate ?? raw.return_rate ?? raw.profit_rate)
    const roi = rawRoi != null ? rawRoi * 100 : null
    const rawWr = safeNumber(raw.win_rate ?? raw.winRate ?? raw.winning_rate)
    const winRate = rawWr != null ? rawWr * 100 : null
    const rawMdd = safeNumber(raw.max_drawdown ?? raw.maxDrawdown ?? raw.mdd)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd * 100) : null

    return {
      trader_key: raw.trader_id ?? raw.traderId ?? raw.uid ?? raw.id ?? null,
      display_name: raw.nick_name ?? raw.nickName ?? raw.nickname ?? raw.account_name ?? raw.name ?? null,
      avatar_url: raw.avatar ?? raw.avatar_url ?? null,
      roi,
      pnl: safeNumber(raw.profit_amount ?? raw.pnl ?? raw.profit ?? raw.total_pnl_amount),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: safeNumber(raw.trade_count ?? raw.tradeCount ?? raw.trades_count),
      followers: safeNumber(raw.follower_count ?? raw.followerCount ?? raw.copier_num ?? raw.cur_follower_num),
      copiers: null,
      aum: safeNumber(raw.aum),
      sharpe_ratio: (() => {
        const series = raw.profit_rate_series as Array<[number, string]> | undefined
        if (!Array.isArray(series) || series.length < 7) return null
        const roiValues = series.map(p => Number(p[1])).filter(n => !isNaN(n))
        if (roiValues.length < 7) return null
        const returns = roiValues.slice(1).map((v, i) => v - roiValues[i])
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length
        const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
        if (std <= 0) return null
        const sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
        return Math.max(-10, Math.min(10, sharpe))
      })(),
      platform_rank: null,
      // Extra: equity curve from profit_rate_series
      _profit_rate_series: raw.profit_rate_series,
      _trade_days: safeNumber(raw.trade_days),
      _total_profit_amount: safeNumber(raw.total_profit_amount),
    }
  }
}

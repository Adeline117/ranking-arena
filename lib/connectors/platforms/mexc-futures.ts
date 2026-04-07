/**
 * MEXC Futures Connector
 *
 * Uses MEXC's copy trading API.
 * Endpoint: futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list
 */

import { BaseConnector } from '../base'
import { normalizeRoiFormat } from '../normalize-contract'
import { warnValidate } from '../schemas'
import { MexcFuturesDetailResponseSchema } from './schemas'
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
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: ['CF protected — mobile UA bypass', 'No timeseries endpoint available'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, _offset = 0): Promise<DiscoverResult> {
    // 2026-03-31: MEXC CloudFlare WAF blocks browser UAs but allows mobile app UAs.
    // Direct API with mobile UA returns 734+ unique traders across 13 categories in a single request.
    // No VPS scraper needed — eliminates 30-90s latency and CF WAF bypass issues.
    const MOBILE_UA = 'MEXC/1.0 (iPhone; iOS 17.0)'
    const seenUids = new Set<string>()
    const allTraders: TraderSource[] = []

    // Primary: Direct API with mobile UA (returns all categories in one request)
    let _rawLb: Record<string, unknown> | null = null
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(
        `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/top?limit=100`,
        {
          method: 'GET',
          headers: {
            'User-Agent': MOBILE_UA,
            'Accept': 'application/json',
          },
          signal: controller.signal,
        }
      )
      clearTimeout(timeout)
      if (res.ok) {
        _rawLb = await res.json() as Record<string, unknown>
      }
    } catch (err) {
      this.logger.debug('MEXC mobile UA fallback:', err instanceof Error ? err.message : String(err))
    }

    // Fallback: VPS Playwright scraper (slow, may timeout with CF WAF)
    if (!_rawLb) {
      const vpsData = await this.fetchViaVPS<Record<string, unknown>>('/mexc/leaderboard', {
        periodType: String(WINDOW_MAP[window]), pageSize: '50', page: '1',
      }, 180000)
      if (vpsData) _rawLb = vpsData
    }

    if (!_rawLb) {
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }

    const dataObj = (_rawLb.data ?? {}) as Record<string, unknown>

    // Merge traders from ALL category lists in the response
    const categoryKeys = [
      'comprehensives', 'rois', 'pnls', 'followers', 'newTraders',
      'highPressureTraders', 'lowPressureTraders', 'bullsTraders', 'bearsTraders',
      'intradayTraders', 'longTermTraders', 'goldTraders', 'silverTraders',
      'list', 'resultList',
    ]

    for (const key of categoryKeys) {
      const list = dataObj[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const raw = item as Record<string, unknown>
        const uid = String(raw.uid || '')
        if (!uid || seenUids.has(uid)) continue
        seenUids.add(uid)
        allTraders.push({
          platform: 'mexc' as const,
          market_type: 'futures' as const,
          trader_key: uid,
          display_name: (raw.nickname as string) || null,
          profile_url: `https://futures.mexc.com/copy-trading/trader/${uid}`,
          discovered_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          is_active: true,
          raw,
        })
      }
    }

    return { traders: allTraders.slice(0, limit), total_available: allTraders.length, window, fetched_at: new Date().toISOString() }
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
      sharpe_ratio: null, sortino_ratio: null, trades_count: this.num(info.openTimes),
      followers: this.num(info.followerCount), copiers: this.num(info.copyCount),
      aum: this.num(info.aum), platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio'],
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
    const roi = normalizeRoiFormat(rawRoi)
    const rawWr = this.num(raw.winRate ?? raw.totalWinRate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
    // Current MEXC API uses maxDrawdown7 (7-day MDD), maxRetrace, or mdd
    const rawMdd = this.num(raw.maxRetrace ?? raw.maxDrawdown7 ?? raw.mdd ?? raw.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    // Compute Sharpe ratio from curveValues (daily ROI equity curve points)
    const curveValues = raw.curveValues as number[] | undefined
    let sharpe: number | null = null
    if (Array.isArray(curveValues) && curveValues.length >= 5) {
      const returns: number[] = []
      for (let i = 1; i < curveValues.length; i++) {
        returns.push((curveValues[i] as number) - (curveValues[i - 1] as number))
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
      if (std > 0) {
        const raw_sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
        sharpe = Math.max(-10, Math.min(10, raw_sharpe))
      }
    }

    return {
      trader_key: raw.uid ?? raw.traderId ?? raw.id ?? raw.userId ?? null,
      display_name: raw.nickname ?? raw.nickName ?? raw.name ?? raw.displayName ?? raw.traderName ?? null,
      avatar_url: raw.avatar ?? raw.avatarUrl ?? raw.headImg ?? null,
      roi,
      pnl: this.num(raw.pnl ?? raw.totalPnl ?? raw.profit),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: this.num(raw.openTimes),
      followers: this.num(raw.followers ?? raw.followerCount ?? raw.copierCount),
      copiers: this.num(raw.historyFollowers),
      aum: this.num(raw.followCopyFunds ?? raw.equity),
      sharpe_ratio: sharpe,
      platform_rank: this.num(raw.order),
      // Extra: equity curve data from leaderboard API
      _curve_time: raw.curveTime,
      _curve_values: raw.curveValues,
      _pnl_curve_values: raw.pnlCurveValues,
      // Extra: portfolio allocation
      _contract_rate_list: raw.contractRateList,
      // Extra: trading style tags
      _tags: raw.tags,
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

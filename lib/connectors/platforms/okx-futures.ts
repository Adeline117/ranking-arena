/**
 * OKX Futures Connector
 *
 * Uses OKX's priapi for copy trading leaderboard.
 * Endpoint: www.okx.com/priapi/v5/ecotrade/public/trader-list
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { OkxFuturesLeaderboardResponseSchema, OkxFuturesDetailResponseSchema } from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags, TraderTimeseries,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const WINDOW_MAP: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' }
// Mapping for v5 copytrading API
const V5_WINDOW_MAP: Record<Window, string> = { '7d': '7d', '30d': '30d', '90d': '90d' }

export class OkxFuturesConnector extends BaseConnector {
  readonly platform = 'okx' as const
  readonly marketType = 'futures' as const

  constructor(config?: Partial<import('../types').ConnectorConfig>) {
    super({ timeout: 10000, maxRetries: 0, ...config }) // No retries: 5 pages × 3 windows must fit in CF 100s timeout
  }

  readonly capabilities: PlatformCapabilities = {
    platform: 'okx',
    market_types: ['futures', 'copy'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['priapi endpoints, CF protected'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, offset = 0): Promise<DiscoverResult> {
    // v5 copytrading public API (priapi removed 2026-03-14)
    // OKX returns max 20 per page.
    const pageSize = 20
    const maxPages = Math.min(Math.ceil(limit / pageSize), 100)
    const allTraders: TraderSource[] = []

    for (let page = Math.floor(offset / pageSize) + 1; page <= maxPages + Math.floor(offset / pageSize); page++) {
      let _rawLb: Record<string, unknown>
      try {
        _rawLb = await this.request<Record<string, unknown>>(
          `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&sortType=pnl&dataRange=${V5_WINDOW_MAP[window]}&pageNo=${page}&limit=${pageSize}`,
          { method: 'GET' }
        )
      } catch (err) {
        console.warn(`[okx] Page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
        break // Stop pagination on error instead of hanging
      }
      const data = warnValidate(OkxFuturesLeaderboardResponseSchema, _rawLb, 'okx-futures/leaderboard')

      // v5 response: { code: "0", data: [{ ranks: [...], totalPage, dataVer }] }
      const dataArr = Array.isArray(data?.data) ? data.data[0] : data?.data
      const list = dataArr?.ranks || []
      if (!Array.isArray(list) || list.length === 0) break

      for (const item of list as Record<string, unknown>[]) {
        allTraders.push({
          platform: 'okx' as const, market_type: 'futures' as const,
          trader_key: String(item.uniqueCode || item.uniqueName || ''),
          display_name: (item.nickName as string) || null,
          profile_url: `https://www.okx.com/copy-trading/account/${item.uniqueCode || item.uniqueName}`,
          discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
          is_active: true, raw: item as Record<string, unknown>,
        })
      }

      if (list.length < pageSize) break
      if (allTraders.length >= limit) break
      await new Promise(r => setTimeout(r, 100))
    }

    return { traders: allTraders.slice(0, limit), total_available: allTraders.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://www.okx.com/priapi/v5/ecotrade/public/trader-detail?uniqueName=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(OkxFuturesDetailResponseSchema, _rawProfile, 'okx-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'okx', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickName as string) || null,
      avatar_url: (info.portrait as string) || null,
      bio: (info.desc as string) || null, tags: [],
      profile_url: `https://www.okx.com/copy-trading/account/${traderKey}`,
      followers: this.num(info.followerNum), copiers: this.num(info.copyTraderNum),
      aum: this.num(info.aum),
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'okx', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://www.okx.com/priapi/v5/ecotrade/public/profit-detail?uniqueName=${traderKey}&dataRange=${WINDOW_MAP[window]}`,
      { method: 'GET' }
    )
    const data = warnValidate(OkxFuturesDetailResponseSchema, _rawSnap, 'okx-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.decimalToPercent(info.profitRatio),
      pnl: this.num(info.profit),
      win_rate: this.decimalToPercent(info.winRatio),
      max_drawdown: this.decimalToPercent(info.maxDrawdown),
      sharpe_ratio: null, sortino_ratio: null,
      trades_count: this.num(info.tradeCount),
      followers: this.num(info.followerNum),
      copiers: this.num(info.copyTraderNum),
      aum: this.num(info.aum), platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio'],
      non_standard_fields: {}, window_native: true, notes: [],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    const _rawTs = await this.request<Record<string, unknown>>(
      `https://www.okx.com/priapi/v5/ecotrade/public/profit-detail?uniqueName=${traderKey}&dataRange=90`,
      { method: 'GET' }
    )
    const data = warnValidate(OkxFuturesDetailResponseSchema, _rawTs, 'okx-futures/timeseries')
    const dailyList = data?.data?.dailyProfitList || []

    const series: TraderTimeseries[] = []
    if (Array.isArray(dailyList) && dailyList.length > 0) {
      series.push({
        platform: 'okx', market_type: 'futures', trader_key: traderKey,
        series_type: 'daily_pnl', as_of_ts: new Date().toISOString(),
        data: dailyList.map((item: Record<string, unknown>) => ({
          ts: new Date(Number(item.ts) || Date.now()).toISOString(),
          value: Number(item.profit) || 0,
        })),
        updated_at: new Date().toISOString(),
      })
    }
    return { series, fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw OKX leaderboard entry.
   * Raw fields: uniqueName, nickName, profitRatio (decimal), profit,
   * winRatio (decimal 0-1), copyTraderNum, portLink (avatar), sharpeRatio.
   * MDD computed from pnlRatios in discoverLeaderboard → stored as _computed_mdd.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const winRatio = this.num(raw.winRatio)
    return {
      trader_key: raw.uniqueCode ?? raw.uniqueName ?? null,
      display_name: raw.nickName ?? null,
      avatar_url: raw.portLink ?? null,
      roi: this.decimalToPercent(raw.pnlRatio ?? raw.profitRatio),
      pnl: this.num(raw.pnl ?? raw.profit),
      win_rate: winRatio != null ? (winRatio <= 1 ? winRatio * 100 : winRatio) : null,
      max_drawdown: raw._computed_mdd != null ? Number(raw._computed_mdd) : null,
      trades_count: null,
      followers: this.num(raw.accCopyTraderNum ?? raw.copyTraderNum),
      copiers: this.num(raw.copyTraderNum),
      aum: this.num(raw.aum),
      sharpe_ratio: raw.sharpeRatio != null ? Number(raw.sharpeRatio) : null,
      platform_rank: null,
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return !Number.isFinite(n) ? null : n
  }

  private decimalToPercent(val: unknown): number | null {
    const n = this.num(val)
    if (n === null) return null
    // OKX returns decimals (0.25 = 25%), convert to percentage
    return Math.abs(n) < 10 ? n * 100 : n
  }
}

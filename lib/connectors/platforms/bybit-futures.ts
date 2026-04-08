/**
 * Bybit Futures Connector
 *
 * Uses Bybit's public beehive API for copy trading leaderboard.
 * Endpoint: api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  BybitFuturesDetailResponseSchema,
  BybitFuturesTimeseriesResponseSchema,
} from './schemas'
import type {
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  TraderSource,
  TraderProfile,
  SnapshotMetrics,
  QualityFlags,
  TraderTimeseries,
  PlatformCapabilities,
  Window,
} from '../../types/leaderboard'

const WINDOW_MAP: Record<Window, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
}

// Bybit's x-api uses DATA_DURATION_* enum for the dataDuration param
const SCRAPER_DURATION_MAP: Record<Window, string> = {
  '7d': 'DATA_DURATION_SEVEN_DAY',
  '30d': 'DATA_DURATION_THIRTY_DAY',
  '90d': 'DATA_DURATION_NINETY_DAY',
}

export class BybitFuturesConnector extends BaseConnector {
  readonly platform = 'bybit' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'bybit',
    market_types: ['futures', 'copy'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 30, concurrency: 2 },
    notes: ['Public REST API', 'No CF challenges on API endpoints'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, offset = 0): Promise<DiscoverResult> {
    const timeRange = WINDOW_MAP[window]
    const pageSize = 100
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []
    let totalAvailable: number | null = null

    for (let page = Math.floor(offset / pageSize) + 1; page <= maxPages; page++) {
      // Bybit API is geo-blocked from datacenter IPs — use VPS Playwright scraper.
      const vpsData = await this.fetchViaVPS<Record<string, unknown>>('/bybit/leaderboard', {
        dataDuration: SCRAPER_DURATION_MAP[window],
        pageNo: String(page),
        pageSize: String(pageSize),
      }, 70000) // 70s per VPS call — 3 calls (1 page/window × 3 windows) must fit in 240s budget

      let _rawLb: Record<string, unknown>
      if (vpsData) {
        _rawLb = vpsData
      } else {
        // NEW 2026-04-08: dynamic-leader-list is WAF-blocked but leader-details is NOT.
        // We use the DB as "seed list" of known bybit traders and refresh their snapshots.
        // Discovery of NEW traders requires VPS scraper — when VPS is down, we gracefully
        // return existing traders from DB instead of throwing.
        if (page === 1 + Math.floor(offset / pageSize) && allTraders.length === 0) {
          this.logger.warn('[bybit] VPS scraper unavailable — falling back to DB seed list (will refresh existing traders but no new ones)')
          try {
            const { getSupabaseAdmin } = await import('@/lib/supabase/server')
            const supabase = getSupabaseAdmin()
            const { data: existingTraders } = await supabase
              .from('trader_snapshots_v2')
              .select('trader_key, metrics')
              .eq('platform', 'bybit')
              .eq('window', window.toUpperCase())
              .gte('updated_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
              .order('updated_at', { ascending: false })
              .limit(limit)

            if (existingTraders && existingTraders.length > 0) {
              const seedTraders: TraderSource[] = existingTraders.map((t) => {
                const metrics = (t.metrics as Record<string, unknown>) || {}
                return {
                  platform: 'bybit' as const,
                  market_type: 'futures' as const,
                  trader_key: String(t.trader_key),
                  display_name: (metrics.nickName as string) || null,
                  profile_url: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${t.trader_key}`,
                  discovered_at: new Date().toISOString(),
                  last_seen_at: new Date().toISOString(),
                  is_active: true,
                  raw: { _source: 'db_seed' } as Record<string, unknown>,
                }
              })
              this.logger.info(`[bybit] DB seed list returned ${seedTraders.length} known traders for ${window}`)
              return {
                traders: seedTraders,
                total_available: seedTraders.length,
                window,
                fetched_at: new Date().toISOString(),
              }
            }
          } catch (err) {
            this.logger.warn('[bybit] DB seed fallback failed:', err instanceof Error ? err.message : String(err))
          }
          throw new Error(`Bybit: VPS scraper unavailable and no DB seed list available. Check VPS_SCRAPER_SG connectivity.`)
        }
        this.logger.debug('Bybit: VPS unavailable on later page, stopping pagination')
        break
      }

      const resultObj = (_rawLb as Record<string, unknown>)?.result as Record<string, unknown> | undefined
      const leaderDetails = resultObj?.leaderDetails as unknown[] | undefined
      const dataArr = resultObj?.data as unknown[] | undefined
      const rawList = (leaderDetails?.length ? leaderDetails : null)
        || (dataArr?.length ? dataArr : null)
        || []
      const list = (Array.isArray(rawList) ? rawList : []) as Record<string, unknown>[]

      if (totalAvailable == null && resultObj?.total) totalAvailable = Number(resultObj.total)
      if (list.length === 0) break

      for (const item of list) {
        allTraders.push({
          platform: 'bybit' as const,
          market_type: 'futures' as const,
          trader_key: String(item.leaderMark || ''),
          display_name: (item.nickName as string) || null,
          profile_url: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${item.leaderMark}`,
          discovered_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          is_active: true,
          raw: item as Record<string, unknown>,
        })
      }

      if (list.length < pageSize) break
    }

    return {
      traders: allTraders.slice(0, limit),
      total_available: totalAvailable,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-details?leaderMark=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(BybitFuturesDetailResponseSchema, _rawProfile, 'bybit-futures/profile')

    const info = data?.result

    if (!info) return null

    const profile: TraderProfile = {
      platform: 'bybit',
      market_type: 'futures',
      trader_key: traderKey,
      display_name: (info.nickName as string) || null,
      avatar_url: (info.avatar as string) || null,
      bio: (info.introduction as string) || null,
      tags: [],
      profile_url: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${traderKey}`,
      followers: typeof info.followerCount === 'number' ? info.followerCount : null,
      copiers: typeof info.currentFollowerCount === 'number' ? info.currentFollowerCount : null,
      aum: typeof info.aum === 'number' ? info.aum : null,
      updated_at: new Date().toISOString(),
      last_enriched_at: new Date().toISOString(),
      provenance: {
        source_platform: 'bybit',
        acquisition_method: 'api',
        fetched_at: new Date().toISOString(),
        source_url: `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-details?leaderMark=${traderKey}`,
        scraper_version: '1.0.0',
      },
    }

    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const timeRange = WINDOW_MAP[window]

    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-details?leaderMark=${traderKey}&timeRange=${timeRange}`,
      { method: 'GET' }
    )
    const data = warnValidate(BybitFuturesDetailResponseSchema, _rawSnap, 'bybit-futures/snapshot')

    const info = data?.result

    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.parseNumber(info.roi),
      pnl: this.parseNumber(info.pnl),
      win_rate: this.parseNumber(info.winRate),
      max_drawdown: this.parseNumber(info.maxDrawdown),
      sharpe_ratio: null,
      sortino_ratio: null,
      trades_count: typeof info.tradeCount === 'number' ? info.tradeCount : null,
      followers: typeof info.followerCount === 'number' ? info.followerCount : null,
      copiers: typeof info.currentFollowerCount === 'number' ? info.currentFollowerCount : null,
      aum: this.parseNumber(info.aum),
      platform_rank: null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
    }

    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio'],
      non_standard_fields: {},
      window_native: true,
      notes: [],
    }

    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    const _rawTs = await this.request<Record<string, unknown>>(
      `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-history-pnl?leaderMark=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(BybitFuturesTimeseriesResponseSchema, _rawTs, 'bybit-futures/timeseries')

    const pnlList = data?.result?.pnlList || []

    const series: TraderTimeseries[] = []

    if (pnlList.length > 0) {
      series.push({
        platform: 'bybit',
        market_type: 'futures',
        trader_key: traderKey,
        series_type: 'daily_pnl',
        as_of_ts: new Date().toISOString(),
        data: pnlList.map((item: Record<string, unknown>) => ({
          ts: new Date(Number(item.timestamp) || Date.now()).toISOString(),
          value: Number(item.pnl) || 0,
        })),
        updated_at: new Date().toISOString(),
      })

      series.push({
        platform: 'bybit',
        market_type: 'futures',
        trader_key: traderKey,
        series_type: 'equity_curve',
        as_of_ts: new Date().toISOString(),
        data: pnlList.map((item: Record<string, unknown>) => ({
          ts: new Date(Number(item.timestamp) || Date.now()).toISOString(),
          value: Number(item.roi) || 0,
        })),
        updated_at: new Date().toISOString(),
      })
    }

    return { series, fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // Parse metricValues array from VPS scraper (bybitglobal.com format)
    // [0]=ROI, [1]=Drawdown, [2]=FollowerProfit, [3]=WinRate, [4]=ProfitLossRatio, [5]=SharpeRatio
    const mv = Array.isArray(raw.metricValues) ? raw.metricValues as string[] : null

    const roi = this.parseNumber(raw.roi) ?? this.parsePercent(mv?.[0])
    const maxDrawdown = this.parseNumber(raw.maxDrawdown) ?? this.parsePercent(mv?.[1])
    const winRate = this.parseNumber(raw.winRate) ?? this.parsePercent(mv?.[3])
    const sharpeRatio = this.parseNumber(raw.sharpeRatio) ?? this.parsePercent(mv?.[5])

    return {
      trader_key: raw.leaderMark || raw.leaderUserId,
      display_name: raw.nickName,
      avatar_url: raw.avatar ?? raw.avatarUrl ?? raw.headUrl ?? null,
      roi,
      pnl: this.parseNumber(raw.pnl) ?? this.parseNumber(raw.totalPnl) ?? this.parseNumber(raw.profit),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      sharpe_ratio: sharpeRatio,
      followers: this.parseNumber(raw.followerCount) ?? this.parseNumber(raw.maxFollowerCount),
      copiers: this.parseNumber(raw.currentFollowerCount),
    }
  }

  /** Parse "+1044.26%" or "34.66%" to number */
  private parsePercent(val: string | undefined | null): number | null {
    if (!val) return null
    const cleaned = val.replace(/[+%]/g, '').trim()
    if (!cleaned || cleaned === '--') return null
    const num = Number(cleaned)
    return !Number.isFinite(num) ? null : num
  }

  private parseNumber(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const num = Number(val)
    return !Number.isFinite(num) ? null : num
  }
}

/**
 * Bitget Futures Connector
 *
 * Uses Bitget's public copy trading API.
 * Endpoint: www.bitget.com/v1/trigger/trace/public/currentTrader/list
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  BitgetFuturesDetailResponseSchema,
  BitgetFuturesTimeseriesResponseSchema,
} from './schemas'
import type {
  LeaderboardPlatform,
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

const WINDOW_MAP: Record<Window, number> = {
  '7d': 1,
  '30d': 2,
  '90d': 3,
}

// VPS scraper POSTs to /traderList which expects string period names
const VPS_PERIOD_MAP: Record<Window, string> = {
  '7d': 'SEVEN_DAYS',
  '30d': 'THIRTY_DAYS',
  '90d': 'NINETY_DAYS',
}

export class BitgetFuturesConnector extends BaseConnector {
  readonly platform = 'bitget_futures' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'bitget_futures' as LeaderboardPlatform,
    market_types: ['futures', 'spot'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['CF protected but API accessible', 'Good field coverage'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, offset = 0): Promise<DiscoverResult> {
    const timeRange = WINDOW_MAP[window]

    // Auto-paginate: fetch all pages
    const allTraders: TraderSource[] = []
    let currentPage = Math.floor(offset / 100) + 1
    const maxPages = Math.ceil(Math.min(limit, 2000) / 100)
    let totalAvailable: number | null = null
    // Total timeout: 4 minutes — hard cap to prevent cron hangs
    const totalDeadline = Date.now() + 4 * 60 * 1000

    while (currentPage <= maxPages) {
      // Bail if approaching total deadline
      if (Date.now() > totalDeadline) break

      // Bitget is CF-protected; proxy forwards get empty responses.
      // Try VPS Playwright scraper first, fall back to direct API.
      let _rawLb: Record<string, unknown>
      const pageSize = 100 // Bitget API max per page — was passing limit (2000) causing huge VPS scraper load
      const vpsData = await this.fetchViaVPS<Record<string, unknown>>('/bitget/leaderboard', {
        period: VPS_PERIOD_MAP[window], pageNo: String(currentPage), pageSize: String(pageSize),
      }, 60000) // 60s per page (reduced from 120s)
      if (vpsData) {
        _rawLb = vpsData
      } else {
        _rawLb = await this.request<Record<string, unknown>>(
          `https://www.bitget.com/v1/trigger/trace/public/currentTrader/list?pageNo=${currentPage}&pageSize=${pageSize}&sortType=2&timeRange=${timeRange}`,
          { method: 'GET' }
        )
      }
      // Parse directly — Zod defaults data.list=[] hiding scraper's data.traderList/data.rows
      const dataObj = (_rawLb?.data ?? {}) as Record<string, unknown>
      if (totalAvailable === null && dataObj?.total) totalAvailable = Number(dataObj.total)

      const list = (dataObj?.list || dataObj?.traderList || dataObj?.rows || []) as Record<string, unknown>[]
      if (!Array.isArray(list) || list.length === 0) break

      const traders: TraderSource[] = list.map((item: Record<string, unknown>) => ({
        platform: 'bitget_futures' as const,
        market_type: 'futures' as const,
        trader_key: String(item.traderId || item.traderUid || ''),
        display_name: (item.traderName as string) || (item.traderNickName as string) || null,
        profile_url: `https://www.bitget.com/copy-trading/trader/${item.traderId || item.traderUid}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: item as Record<string, unknown>,
      }))
      allTraders.push(...traders)

      if (list.length < pageSize) break
      currentPage++
      await new Promise(r => setTimeout(r, 500))
    }

    return {
      traders: allTraders,
      total_available: totalAvailable ?? allTraders.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitgetFuturesDetailResponseSchema, _rawProfile, 'bitget-futures/profile')

    const info = data?.data

    if (!info) return null

    const profile: TraderProfile = {
      platform: 'bitget_futures',
      market_type: 'futures',
      trader_key: traderKey,
      display_name: (info.traderName as string) || null,
      avatar_url: (info.headUrl as string) || null,
      bio: (info.introduction as string) || null,
      tags: [],
      profile_url: `https://www.bitget.com/copy-trading/trader/${traderKey}`,
      followers: this.toInt(info.followerNum),
      copiers: this.toInt(info.copyTraderNum),
      aum: this.parseNumber(info.totalFollowAssets),
      updated_at: new Date().toISOString(),
      last_enriched_at: new Date().toISOString(),
      provenance: {
        source_platform: 'bitget_futures',
        acquisition_method: 'api',
        fetched_at: new Date().toISOString(),
        source_url: `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${traderKey}`,
        scraper_version: '1.0.0',
      },
    }

    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const timeRange = WINDOW_MAP[window]

    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${traderKey}&timeRange=${timeRange}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitgetFuturesDetailResponseSchema, _rawSnap, 'bitget-futures/snapshot')

    const info = data?.data

    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.parseNumber(info.roi),
      pnl: this.parseNumber(info.profit),
      win_rate: this.parseNumber(info.winRate),
      max_drawdown: this.parseNumber(info.drawDown),
      sharpe_ratio: null,
      sortino_ratio: null,
      trades_count: this.toInt(info.totalOrder),
      followers: this.toInt(info.followerNum),
      copiers: this.toInt(info.copyTraderNum),
      aum: this.parseNumber(info.totalFollowAssets),
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
      `https://www.bitget.com/v1/trigger/trace/public/trader/profitList?traderId=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitgetFuturesTimeseriesResponseSchema, _rawTs, 'bitget-futures/timeseries')

    const profitList = data?.data || []

    const series: TraderTimeseries[] = []

    if (Array.isArray(profitList) && profitList.length > 0) {
      series.push({
        platform: 'bitget_futures',
        market_type: 'futures',
        trader_key: traderKey,
        series_type: 'daily_pnl',
        as_of_ts: new Date().toISOString(),
        data: profitList.map((item: Record<string, unknown>) => ({
          ts: new Date(Number(item.date) || Date.now()).toISOString(),
          value: Number(item.profit) || 0,
        })),
        updated_at: new Date().toISOString(),
      })
    }

    return { series, fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw Bitget leaderboard entry.
   * Raw fields: traderId, traderName, roi, profit, winRate, drawDown,
   * followerNum, copyTraderNum, totalFollowAssets (AUM), headUrl (avatar).
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // Two API response formats:
    //   currentTrader/list (GET):  roi (%), winRate (%), drawDown (%), traderId, traderName, headUrl
    //   traderList (POST, VPS):    profitRate/returnRate (decimal), winningRate (decimal), traderUid, traderNickName, headPic
    //
    // The traderList API returns ratios as decimals (0.155 = 15.5%).
    // The currentTrader/list API returns already-percentage values (15.5 = 15.5%).
    // We detect which format by checking which field is present.

    const isTraderListFormat = raw.profitRate != null || raw.returnRate != null

    // ROI: currentTrader/list "roi" is percentage; traderList "profitRate"/"returnRate" is decimal
    let roi: number | null = null
    if (raw.roi != null) {
      roi = this.parseNumber(raw.roi)
    } else {
      const rawRate = this.parseNumber(raw.returnRate ?? raw.profitRate ?? raw.yieldRate)
      roi = rawRate != null ? rawRate * 100 : null
    }

    // Win rate: currentTrader/list "winRate" is percentage; traderList "winningRate" is decimal
    let winRate: number | null = null
    if (raw.winRate != null) {
      winRate = this.parseNumber(raw.winRate)
    } else if (raw.winningRate != null) {
      const rawWr = this.parseNumber(raw.winningRate)
      winRate = rawWr != null ? rawWr * 100 : null
    }

    // Max drawdown: currentTrader/list "drawDown" is percentage; traderList "maxDrawdown" may be decimal
    let maxDrawdown: number | null = null
    if (raw.drawDown != null) {
      maxDrawdown = this.parseNumber(raw.drawDown)
    } else {
      const rawMdd = this.parseNumber(raw.maxDrawdown ?? raw.mdd)
      // If from traderList and looks like a decimal (< 1), convert to percentage
      if (rawMdd != null && isTraderListFormat && Math.abs(rawMdd) <= 1) {
        maxDrawdown = rawMdd * 100
      } else {
        maxDrawdown = rawMdd
      }
    }

    return {
      trader_key: raw.traderId ?? raw.traderUid ?? raw.uid ?? null,
      display_name: raw.traderName ?? raw.traderNickName ?? raw.nickName ?? null,
      avatar_url: raw.headUrl ?? raw.headPic ?? raw.avatar ?? null,
      roi,
      pnl: this.parseNumber(raw.profit ?? raw.totalProfit ?? raw.totalFollowProfit ?? raw.allTotalRevenue),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: this.parseNumber(raw.tradeTimes) ?? null,
      followers: this.parseNumber(raw.followerNum ?? raw.followerCount ?? raw.copyUserNum ?? raw.traceNum),
      copiers: this.parseNumber(raw.copyTraderNum),
      aum: this.parseNumber(raw.totalFollowAssets),
      sharpe_ratio: null,
      platform_rank: null,
    }
  }

  private parseNumber(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const num = Number(val)
    return !Number.isFinite(num) ? null : num
  }

  private toInt(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const num = parseInt(String(val), 10)
    return !Number.isFinite(num) ? null : num
  }
}

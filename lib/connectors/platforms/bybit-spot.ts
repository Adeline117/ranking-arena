/**
 * Bybit Spot Connector
 *
 * Uses the same VPS Playwright scraper as bybit-futures, but with leaderTag=LEADER_TAG_SPOT.
 * The VPS endpoint /bybit/leaderboard supports both futures and spot via the leaderTag param.
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  TraderSource,
  PlatformCapabilities,
  Window,
  LeaderboardPlatform,
} from '../../types/leaderboard'

const SCRAPER_DURATION_MAP: Record<Window, string> = {
  '7d': 'DATA_DURATION_SEVEN_DAY',
  '30d': 'DATA_DURATION_THIRTY_DAY',
  '90d': 'DATA_DURATION_NINETY_DAY',
}

export class BybitSpotConnector extends BaseConnector {
  readonly platform = 'bybit_spot' as LeaderboardPlatform
  readonly marketType = 'spot' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'bybit_spot' as LeaderboardPlatform,
    market_types: ['spot'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'win_rate', 'max_drawdown', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 3,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: ['Uses VPS Playwright scraper with leaderTag=LEADER_TAG_SPOT'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, offset = 0): Promise<DiscoverResult> {
    const page = Math.floor(offset / limit) + 1
    const totalDeadline = Date.now() + 4 * 60 * 1000

    const vpsData = await this.fetchViaVPS<Record<string, unknown>>('/bybit/leaderboard', {
      dataDuration: SCRAPER_DURATION_MAP[window],
      pageNo: String(page),
      pageSize: String(limit),
      leaderTag: 'LEADER_TAG_SPOT',
    }, 90000) // 90s — Playwright scraper can be slow

    if (Date.now() > totalDeadline) {
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }

    let list: Record<string, unknown>[] = []
    if (vpsData) {
      const resultObj = vpsData.result as Record<string, unknown> | undefined
      const leaderDetails = resultObj?.leaderDetails as unknown[] | undefined
      const dataArr = resultObj?.data as unknown[] | undefined
      list = (leaderDetails?.length ? leaderDetails : dataArr?.length ? dataArr : []) as Record<string, unknown>[]
    } else {
      // VPS scraper unavailable — throw explicit error for pipeline tracking
      throw new Error('Bybit Spot: VPS scraper unavailable and no direct API fallback. Check VPS_SCRAPER_SG connectivity.')
    }

    const traders: TraderSource[] = list.map((item) => ({
      platform: 'bybit_spot' as const,
      market_type: 'spot' as const,
      trader_key: String(item.leaderMark || ''),
      display_name: (item.nickName as string) || null,
      profile_url: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${item.leaderMark}`,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: item,
    }))

    return {
      traders,
      total_available: (vpsData?.result as Record<string, unknown>)?.total as number || null,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(_traderKey: string): Promise<ProfileResult | null> {
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as Record<string, unknown>
    const mv = Array.isArray(e.metricValues) ? e.metricValues as string[] : null

    return {
      trader_key: e.leaderMark || e.leaderUserId,
      display_name: e.nickName,
      avatar_url: e.avatar ?? e.avatarUrl ?? e.headUrl ?? null,
      roi: this.parseNumber(e.roi) ?? this.parsePercent(mv?.[0]),
      pnl: this.parseNumber(e.pnl) ?? this.parseNumber(e.totalPnl) ?? this.parseNumber(e.profit),
      win_rate: this.parseNumber(e.winRate) ?? this.parsePercent(mv?.[3]),
      max_drawdown: this.parseNumber(e.maxDrawdown) ?? this.parsePercent(mv?.[1]),
      sharpe_ratio: this.parseNumber(e.sharpeRatio) ?? this.parsePercent(mv?.[5]),
      trades_count: null,
      followers: this.parseNumber(e.followerCount) ?? this.parseNumber(e.maxFollowerCount),
      copiers: this.parseNumber(e.currentFollowerCount),
      aum: this.parseNumber(e.aum),
      platform_rank: null,
    }
  }

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

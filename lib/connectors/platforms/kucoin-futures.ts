/**
 * KuCoin Futures Connector
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { KucoinFuturesLeaderboardResponseSchema, KucoinFuturesDetailResponseSchema } from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const WINDOW_MAP: Record<Window, string> = { '7d': 'SEVEN_DAY', '30d': 'THIRTY_DAY', '90d': 'NINETY_DAY' }

export class KucoinFuturesConnector extends BaseConnector {
  readonly platform = 'kucoin' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'kucoin',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: ['CF protected', 'All 3 windows supported'],
  }

  async discoverLeaderboard(window: Window, limit = 50, offset = 0): Promise<DiscoverResult> {
    const pageNo = Math.floor(offset / limit) + 1

    // Strategy 1: VPS Playwright scraper (primary — KuCoin API returns 404 from datacenter)
    const vpsData = await this.fetchViaVPS<Record<string, unknown>>('/kucoin/leaderboard', {
      pageNo: String(pageNo), pageSize: String(limit),
    }, 90000) // 90s — CF challenge can be slow

    let rawList: Record<string, unknown>[] = []
    if (vpsData) {
      const dataObj = (vpsData?.data ?? vpsData) as Record<string, unknown>
      const items = dataObj?.items || dataObj?.list || dataObj?.rows
      if (Array.isArray(items)) rawList = items as Record<string, unknown>[]
    }

    // Strategy 2: Direct API fallback (may work from residential IPs)
    if (rawList.length === 0) {
      try {
        const _rawLb = await this.request<Record<string, unknown>>(
          `https://www.kucoin.com/_api/copy-trade/leader/public/list?pageNo=${pageNo}&pageSize=${limit}&orderBy=ROI&period=${WINDOW_MAP[window]}`,
          { method: 'GET' }
        )
        const data = warnValidate(KucoinFuturesLeaderboardResponseSchema, _rawLb, 'kucoin-futures/leaderboard')
        const list = data?.data?.items || []
        if (Array.isArray(list)) rawList = list as Record<string, unknown>[]
      } catch {
        // Direct API failed — expected
      }
    }

    const traders: TraderSource[] = rawList.map((item: Record<string, unknown>) => ({
      platform: 'kucoin' as const, market_type: 'futures' as const,
      trader_key: String(item.uid || item.leaderId || item.id || ''),
      display_name: (item.nickName as string) || (item.name as string) || null,
      profile_url: `https://www.kucoin.com/copy-trading/leader/${item.uid || item.leaderId || item.id}`,
      discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      is_active: true, raw: item as Record<string, unknown>,
    }))
    return { traders, total_available: null, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://www.kucoin.com/_api/copy-trade/leader/public/detail?uid=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(KucoinFuturesDetailResponseSchema, _rawProfile, 'kucoin-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'kucoin', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickName as string) || null,
      avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://www.kucoin.com/copy-trading/leader/${traderKey}`,
      followers: this.num(info.followerCount), copiers: this.num(info.currentCopyCount), aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'kucoin', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://www.kucoin.com/_api/copy-trade/leader/public/detail?uid=${traderKey}&period=${WINDOW_MAP[window]}`,
      { method: 'GET' }
    )
    const data = warnValidate(KucoinFuturesDetailResponseSchema, _rawSnap, 'kucoin-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.num(info.roi), pnl: this.num(info.totalPnl),
      win_rate: this.num(info.winRate), max_drawdown: this.num(info.maxDrawdown),
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: this.num(info.followerCount), copiers: this.num(info.currentCopyCount),
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

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return { trader_key: raw.uid, display_name: raw.nickName, roi: this.num(raw.roi), pnl: this.num(raw.totalPnl) }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return isNaN(n) ? null : n
  }
}

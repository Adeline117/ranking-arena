/**
 * KuCoin Futures Connector
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { KucoinFuturesDetailResponseSchema } from './schemas'
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
    let rawList: Record<string, unknown>[] = []

    // Strategy 1: VPS proxy → POST API (Vercel hnd1 IP blocked by KuCoin)
    const vpsData = await this.proxyViaVPS<Record<string, unknown>>(
      'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query',
      {
        method: 'POST',
        body: JSON.stringify({ currentPage: pageNo, pageSize: limit }),
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      },
      30000,
    )
    if (vpsData) {
      const dataObj = (vpsData?.data ?? vpsData) as Record<string, unknown>
      const items = dataObj?.items || dataObj?.list || dataObj?.rows
      if (Array.isArray(items)) rawList = items as Record<string, unknown>[]
    }

    // Strategy 2: Direct POST API fallback (works from residential IPs)
    if (rawList.length === 0) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15000)
        const res = await fetch(
          'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ currentPage: pageNo, pageSize: limit }),
            signal: controller.signal,
          }
        )
        clearTimeout(timeout)
        if (res.ok) {
          const _rawLb = await res.json() as Record<string, unknown>
          const dataObj = _rawLb?.data as Record<string, unknown>
          const list = dataObj?.items || dataObj?.list
          if (Array.isArray(list)) rawList = list as Record<string, unknown>[]
        }
      } catch (err) {
        this.logger.debug('KuCoin direct API fallback:', err instanceof Error ? err.message : String(err))
      }
    }

    const traders: TraderSource[] = rawList.map((item: Record<string, unknown>) => ({
      platform: 'kucoin' as const, market_type: 'futures' as const,
      // New API uses leadConfigId, old uses uid
      trader_key: String(item.leadConfigId || item.uid || item.leaderId || item.id || ''),
      display_name: (item.nickName as string) || (item.name as string) || null,
      profile_url: `https://www.kucoin.com/copy-trading/leader/${item.leadConfigId || item.uid || item.leaderId || item.id}`,
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
    // New POST API returns thirtyDayPnlRatio as decimal (2.80 = 280%)
    const rawRoi = this.num(raw.thirtyDayPnlRatio ?? raw.totalPnlRatio ?? raw.roi ?? raw.returnRate)
    const roi = rawRoi != null ? (Math.abs(rawRoi) <= 10 ? rawRoi * 100 : rawRoi) : null
    return {
      trader_key: raw.leadConfigId || raw.uid,
      display_name: raw.nickName || raw.name,
      avatar_url: raw.avatarUrl || raw.avatar || null,
      roi,
      pnl: this.num(raw.thirtyDayPnl ?? raw.totalPnl ?? raw.pnl),
      win_rate: null, // Not in leaderboard response
      max_drawdown: null, // Not in leaderboard response
      followers: this.num(raw.currentCopyUserCount ?? raw.followerCount),
      copiers: this.num(raw.currentCopyUserCount ?? raw.currentCopyCount),
      trades_count: this.num(raw.tradeCount),
      aum: this.num(raw.leadPrincipal),
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return !Number.isFinite(n) ? null : n
  }
}

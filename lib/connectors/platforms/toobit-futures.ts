/**
 * Toobit Futures Connector
 *
 * Fetches copy-trading leaderboard from Toobit's API.
 * Direct API pagination is broken (always returns page 1), so uses
 * VPS Playwright scraper as primary strategy.
 *
 * APIs:
 * - VPS: GET {VPS_SCRAPER_URL}/toobit/leaderboard
 * - Direct: GET https://bapi.toobit.com/bapi/v1/copy-trading/ranking
 * - Direct: GET https://bapi.toobit.com/bapi/v1/copy-trading/identity-type-leaders
 *
 * Notes:
 * - ROI as ratio (2.7061 → 270.61%)
 * - Direct API pagination broken; cycles through 5 kind values
 * - identity-type-leaders returns grouped data by leader type
 */

import { BaseConnector } from '../base'
import { safeNumber, safePercent, safeNonNeg, safeStr, safeMdd } from '../utils'
import type {
  LeaderboardPlatform,
  MarketType,
  Window,
  PlatformCapabilities,
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  TraderSource,
} from '../../types/leaderboard'

interface ToobitTraderEntry {
  leaderUserId?: string
  leaderId?: string
  uid?: string
  userId?: string
  id?: string
  name?: string
  nickname?: string
  nickName?: string
  displayName?: string
  profitRatio?: number
  leaderAvgProfitRatio?: number
  profit?: number
  pnl?: number
  leaderProfitOrderRatio?: number
  winRate?: number
  maxDrawdown?: number
  followerTotal?: number
  currentFollowerCount?: number
  followers?: number
  followerCount?: number
  sharpeRatio?: number
  avatar?: string
}

export class ToobitFuturesConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'toobit'
  readonly marketType: MarketType = 'futures'

  readonly capabilities: PlatformCapabilities = {
    platform: 'toobit',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'sharpe_ratio'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: [
      'Direct API pagination broken',
      'VPS Playwright scraper as primary strategy',
      'ROI in ratio format (×100 for percentage)',
    ],
  }

  private mapWindowToDataType(window: Window): number {
    const m: Record<Window, number> = { '7d': 7, '30d': 30, '90d': 90 }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const dataType = this.mapWindowToDataType(window)
    const seen = new Set<string>()
    const allTraders: TraderSource[] = []

    // Strategy 1: VPS Playwright scraper
    try {
      const vpsData = await this.fetchViaVPS<{ traders?: ToobitTraderEntry[] }>(
        `/toobit/leaderboard`,
        { period: String(dataType), pageSize: '50' },
        90000
      )
      // Scraper returns: { code: 200, data: { list: [...] } } or legacy: { traders: [...] }
      const vpsAny = vpsData as Record<string, unknown>
      const traderList = (vpsAny?.traders || (vpsAny?.data as Record<string, unknown>)?.list || []) as ToobitTraderEntry[]
      if (traderList.length) {
        for (const entry of traderList) {
          const id = this.extractId(entry)
          if (!id || seen.has(id)) continue
          seen.add(id)
          allTraders.push(this.toTraderSource(entry, id))
        }
      }
    } catch (err) {
      this.logger.debug('Toobit VPS proxy fallback:', err instanceof Error ? err.message : String(err))
    }

    // Strategy 2: Direct ranking API (cycles through kind values)
    if (allTraders.length < limit) {
      for (const kind of [0, 1, 2, 3, 4]) {
        try {
          const data = await this.request<{ data?: { list?: ToobitTraderEntry[] } }>(
            `https://bapi.toobit.com/bapi/v1/copy-trading/ranking?page=1&dataType=${dataType}&kind=${kind}`,
          )
          for (const entry of data?.data?.list || []) {
            const id = this.extractId(entry)
            if (!id || seen.has(id)) continue
            seen.add(id)
            allTraders.push(this.toTraderSource(entry, id))
          }
        } catch (err) {
          this.logger.debug('Toobit ranking kind fetch fallback:', err instanceof Error ? err.message : String(err))
        }
      }
    }

    // Strategy 3: Identity-type leaders
    if (allTraders.length < limit) {
      try {
        const data = await this.request<{ data?: Record<string, ToobitTraderEntry[]> }>(
          `https://bapi.toobit.com/bapi/v1/copy-trading/identity-type-leaders?dataType=${dataType}`
        )
        if (data?.data) {
          for (const entries of Object.values(data.data)) {
            if (!Array.isArray(entries)) continue
            for (const entry of entries) {
              const id = this.extractId(entry)
              if (!id || seen.has(id)) continue
              seen.add(id)
              allTraders.push(this.toTraderSource(entry, id))
            }
          }
        }
      } catch (err) {
        this.logger.debug('Toobit identity-type leaders fallback:', err instanceof Error ? err.message : String(err))
      }
    }

    return {
      traders: allTraders.slice(0, limit),
      total_available: allTraders.length,
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

  /**
   * Normalize raw Toobit leaderboard entry.
   * profitRatio is ALWAYS a ratio (2.7061 = 270.61%), always ×100.
   * winRate from identity-type-leaders is ratio (0-1).
   * maxDrawdown is ratio (0-1).
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as ToobitTraderEntry
    // profitRatio is always a ratio: 2.7061 = 270.61%
    const roi = safePercent(e.profitRatio ?? e.leaderAvgProfitRatio, { isRatio: true })
    // winRate: ratio 0-1 from identity-type-leaders
    const winRate = safePercent(e.leaderProfitOrderRatio ?? e.winRate, { isRatio: true })
    // maxDrawdown: ratio 0-1
    const maxDrawdown = safeMdd(e.maxDrawdown, true)

    return {
      trader_key: this.extractId(e),
      display_name: safeStr(e.name ?? e.nickname ?? e.nickName ?? e.displayName),
      avatar_url: safeStr(e.avatar),
      roi,
      pnl: safeNumber(e.profit ?? e.pnl),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers: safeNonNeg(e.followerTotal ?? e.currentFollowerCount ?? e.followers ?? e.followerCount),
      sharpe_ratio: safeNumber(e.sharpeRatio),
      trades_count: null,
      aum: null,
      copiers: null,
      platform_rank: null,
    }
  }

  private extractId(e: ToobitTraderEntry): string | null {
    return e.leaderUserId || e.leaderId || e.uid || e.userId || e.id || null
  }

  private toTraderSource(entry: ToobitTraderEntry, id: string): TraderSource {
    return {
      platform: this.platform,
      market_type: this.marketType,
      trader_key: id,
      display_name: entry.name || entry.nickname || entry.nickName || entry.displayName || null,
      profile_url: null,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: entry as unknown as Record<string, unknown>,
    }
  }
}

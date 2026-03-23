/**
 * OKX Spot Connector
 *
 * Uses the same v5 copytrading API as OKX futures but with instType=SPOT.
 * API: www.okx.com/api/v5/copytrading/public-lead-traders?instType=SPOT
 */

import { BaseConnector } from '../base'
import type {
  LeaderboardPlatform,
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, PlatformCapabilities, Window,
} from '../../types/leaderboard'

const V5_WINDOW_MAP: Record<Window, string> = { '7d': '7d', '30d': '30d', '90d': '90d' }

export class OkxSpotConnector extends BaseConnector {
  readonly platform = 'okx_spot' as LeaderboardPlatform
  readonly marketType = 'spot' as const

  constructor(config?: Partial<import('../types').ConnectorConfig>) {
    super({ timeout: 10000, maxRetries: 1, ...config })
  }

  readonly capabilities: PlatformCapabilities = {
    platform: 'okx_spot' as LeaderboardPlatform,
    market_types: ['spot'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'followers', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['Same v5 API as futures with instType=SPOT', 'Direct API works'],
  }

  async discoverLeaderboard(window: Window, limit = 100, offset = 0): Promise<DiscoverResult> {
    const pageSize = 20
    const maxPages = Math.min(Math.ceil(limit / pageSize), 5)
    const allTraders: TraderSource[] = []

    for (let page = Math.floor(offset / pageSize) + 1; page <= maxPages + Math.floor(offset / pageSize); page++) {
      let rawLb: Record<string, unknown>
      try {
        rawLb = await this.request<Record<string, unknown>>(
          `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SPOT&sortType=pnl&dataRange=${V5_WINDOW_MAP[window]}&pageNo=${page}&limit=${pageSize}`,
          { method: 'GET' }
        )
      } catch {
        break
      }

      const dataArr = (rawLb?.data || []) as Record<string, unknown>[]
      const firstItem = dataArr[0] as Record<string, unknown> | undefined
      const ranks = (firstItem?.ranks || []) as Record<string, unknown>[]
      if (!ranks.length) break

      for (const item of ranks) {
        // OKX Spot uses uniqueCode (not uniqueName like futures)
        const traderKey = String(item.uniqueCode || item.uniqueName || '')
        if (!traderKey) continue
        allTraders.push({
          platform: this.platform,
          market_type: 'spot',
          trader_key: traderKey,
          display_name: (item.nickName as string) || null,
          profile_url: `https://www.okx.com/copy-trading/account/${traderKey}`,
          discovered_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          is_active: true,
          raw: item,
        })
      }

      if (ranks.length < pageSize) break
      await this.sleep(500)
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

  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as Record<string, unknown>
    const pnlRatio = e.pnlRatio != null ? Number(e.pnlRatio) : null
    return {
      trader_key: e.uniqueCode || e.uniqueName,
      display_name: e.nickName,
      roi: pnlRatio != null ? pnlRatio * 100 : null, // OKX returns ratio (0.15 = 15%)
      pnl: e.pnl != null ? Number(e.pnl) : null,
      win_rate: e.winRatio != null ? Number(e.winRatio) * 100 : null,
      max_drawdown: null,
      followers: e.copyTraderNum != null ? Number(e.copyTraderNum) : null,
      copiers: e.copyTraderNum != null ? Number(e.copyTraderNum) : null,
      aum: e.aum != null ? Number(e.aum) : null,
    }
  }
}

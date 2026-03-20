/**
 * Pionex Futures Connector
 *
 * Pionex focuses on trading bots rather than manual copy trading.
 * The CopyBot feature only copies grid bots, not manual traders.
 *
 * Key notes:
 * - Pionex does NOT have a public leaderboard API
 * - CopyBot only supports futures grid bots
 * - Discovery is UI-only, no API access
 * - This connector is a stub for potential future scraping
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { PionexFuturesDiscoverResponseSchema } from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface PionexBotEntry {
  botId?: string
  botName?: string
  creatorId?: string
  creatorName?: string
  roi?: number
  pnl?: number
  copiers?: number
  aum?: number
}

export class PionexFuturesConnector extends BaseConnector {
  readonly platform = 'pionex' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'pionex',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 5, // Very difficult - JS heavy, no public API
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: ['No public API', 'Bot-focused platform', 'CopyBot only for grid bots'],
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.pionex.com',
      'Referer': 'https://www.pionex.com/en/copybot',
    }
  }

  async discoverLeaderboard(window: Window, _limit = 100, _offset = 0): Promise<DiscoverResult> {
    // Pionex does not have a public leaderboard API
    // The CopyBot discovery is entirely UI-based
    try {
      // Attempt internal endpoint (likely won't work)
      const _rawLb = await this.request<{ data?: { bots?: PionexBotEntry[] } }>(
        `https://www.pionex.com/api/v1/copybot/discover`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(PionexFuturesDiscoverResponseSchema, _rawLb, 'pionex-futures/discover')

      const bots = data?.data?.bots || []
      const traders: TraderSource[] = bots.map((item) => ({
        platform: 'pionex',
        market_type: 'futures' as const,
        trader_key: String(item.botId || item.creatorId || ''),
        display_name: item.creatorName || item.botName || null,
        profile_url: null,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: item as Record<string, unknown>,
      }))

      return { traders, total_available: traders.length, window, fetched_at: new Date().toISOString() }
    } catch {
      // Expected to fail - Pionex has no public API
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }
  }

  async fetchTraderProfile(_traderKey: string): Promise<ProfileResult | null> {
    // Pionex does not provide trader profiles via API
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    // Pionex does not provide trader snapshots via API
    return {
      metrics: this.emptyMetrics(),
      quality_flags: {
        missing_fields: ['all'],
        non_standard_fields: {},
        window_native: false,
        notes: ['Pionex has no public leaderboard API'],
      },
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      trader_key: raw.botId || raw.creatorId,
      display_name: raw.creatorName || raw.botName,
      roi: this.num(raw.roi),
      pnl: this.num(raw.pnl),
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

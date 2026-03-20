/**
 * Bitfinex Connector
 *
 * Fetches trader rankings from Bitfinex's public v2 rankings API.
 *
 * API: GET https://api-pub.bitfinex.com/v2/rankings/{Key}:{TimeFrame}:tGLOBAL:USD/hist
 * - Public, no auth required
 * - No pagination — single call returns top ~120 traders per key
 * - Two ranking keys: plu_diff (PnL change), plr (PnL ratio)
 * - ROI estimated from PnL / equity proxy
 * - Raw response is array format [mts, ?, username, rank, ?, ?, value, ...]
 */

import { BaseConnector } from '../base'
import { generateBlockieSvg } from '@/lib/utils/avatar'
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

type BitfinexRow = [
  number,   // mts
  unknown,
  string,   // username
  number,   // rank
  unknown,
  unknown,
  number,   // value (PnL)
  ...unknown[]
]

export class BitfinexFuturesConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'bitfinex'
  readonly marketType: MarketType = 'futures'

  readonly capabilities: PlatformCapabilities = {
    platform: 'bitfinex',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],
    available_fields: ['pnl', 'platform_rank'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public API, no auth required',
      'Max ~120 traders per key × timeframe',
      'ROI estimated from PnL / equity proxy',
      '30D and 90D use same 1M timeframe',
    ],
  }

  private mapWindowToTimeframe(window: Window): string {
    return window === '7d' ? '1w' : '1M'
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const timeframe = this.mapWindowToTimeframe(window)
    const traderMap = new Map<string, TraderSource>()

    // Step 1: Fetch all ranking data into lookup maps
    // plu = inception unrealized profit (equity proxy for ROI estimation)
    // plu_diff = PnL change in USD (per period)
    // plr = PnL ratio ranking (proprietary scoring metric, NOT usable as ROI%)
    const equityMap = new Map<string, number>()
    const pnlMap = new Map<string, number>()
    const rankMap = new Map<string, { username: string; rank: number; key: string }>()

    // Fetch equity proxy (always use 1M timeframe for inception data)
    try {
      const equityRows = await this.request<BitfinexRow[]>(
        `https://api-pub.bitfinex.com/v2/rankings/plu:1M:tGLOBAL:USD/hist`
      )
      if (Array.isArray(equityRows)) {
        for (const row of equityRows) {
          if (Array.isArray(row) && row[2] && row[6] != null) {
            equityMap.set(String(row[2]).toLowerCase(), Number(row[6]))
          }
        }
      }
    } catch {
      // Equity proxy not critical — ROI will be null for these traders
    }

    // Fetch PnL diff (actual PnL in USD) — used for ROI estimation for ALL traders
    try {
      const pnlRows = await this.request<BitfinexRow[]>(
        `https://api-pub.bitfinex.com/v2/rankings/plu_diff:${timeframe}:tGLOBAL:USD/hist`
      )
      if (Array.isArray(pnlRows)) {
        for (const row of pnlRows) {
          if (Array.isArray(row) && row[2] && row[6] != null) {
            const id = String(row[2]).toLowerCase()
            pnlMap.set(id, Number(row[6]))
            if (!rankMap.has(id)) {
              rankMap.set(id, { username: String(row[2]), rank: Number(row[3]) || 0, key: 'plu_diff' })
            }
          }
        }
      }
    } catch (err) {
      // PnL data not available — will still try plr for discovery
      if (equityMap.size === 0) throw err
    }

    // Fetch plr (PnL ratio ranking) — used only for discovery of additional traders
    try {
      const plrRows = await this.request<BitfinexRow[]>(
        `https://api-pub.bitfinex.com/v2/rankings/plr:${timeframe}:tGLOBAL:USD/hist`
      )
      if (Array.isArray(plrRows)) {
        for (const row of plrRows) {
          if (Array.isArray(row) && row[2]) {
            const id = String(row[2]).toLowerCase()
            if (!rankMap.has(id)) {
              rankMap.set(id, { username: String(row[2]), rank: Number(row[3]) || 0, key: 'plr' })
            }
          }
        }
      }
    } catch {
      // plr data not critical
    }

    // Step 2: Build trader entries with cross-referenced PnL + equity for ROI
    for (const [id, info] of rankMap) {
      const pnl = pnlMap.get(id) ?? 0
      const equity = equityMap.get(id)

      // Estimate ROI from PnL / equity proxy (lowered threshold from >1 to >0.01)
      let roi: number | null = null
      if (equity != null && Math.abs(equity) > 0.01 && pnl !== 0) {
        roi = Math.max(-500, Math.min(50000, (pnl / Math.abs(equity)) * 100))
      }
      // Fallback: if equity is missing but we have PnL, use plr ranking position
      // to approximate ROI (plr = PnL ratio ranking, higher value = higher ROI)
      if (roi === null && pnl !== 0) {
        // Use pnl as ROI proxy — for bitfinex the plu_diff IS the period PnL in USD
        // Without equity we can't compute %, so leave null (enrichment will fill via daily snapshots)
      }

      traderMap.set(id, {
        platform: this.platform,
        market_type: this.marketType,
        trader_key: id,
        display_name: info.username,
        profile_url: `https://www.bitfinex.com/`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: {
          username: info.username,
          rank: info.rank || null,
          pnl,
          key: info.key,
          timeframe,
          equity: equity ?? null,
          roi,
        },
      })
    }

    const traders = Array.from(traderMap.values()).slice(0, limit)

    return {
      traders,
      total_available: traderMap.size,
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
    return {
      trader_key: e.username ? String(e.username).toLowerCase() : null,
      display_name: e.username ? String(e.username) : null,
      roi: e.roi != null ? Number(e.roi) : null,
      pnl: e.pnl != null ? Number(e.pnl) : null,
      platform_rank: e.rank != null ? Number(e.rank) : null,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      avatar_url: e.username ? generateBlockieSvg(String(e.username), 64) : null,
    }
  }
}

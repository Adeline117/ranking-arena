/**
 * OKX Web3 Connector
 *
 * Fetches copy-trading leaderboard from OKX's public API.
 * Uses same API as okx-futures but with instType=MARGIN then SWAP.
 *
 * API: GET https://www.okx.com/api/v5/copytrading/public-lead-traders
 * - Public, may be geo-blocked (VPS fallback available)
 * - ~10 traders/page, up to 50 pages per instType
 * - Period ROI/MDD derived from pnlRatios cumulative daily series
 */

import { BaseConnector } from '../base'
import { safeNumber, safePercent, safeStr, safeNonNeg } from '../utils'
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

interface OkxLeadTrader {
  uniqueCode: string
  nickName: string
  portLink: string | null
  pnl: string
  totalPnl?: string
  accPnl?: string
  pnlRatio: string
  winRatio: string
  copyTraderNum: string
  followerCount?: string
  pnlRatios?: Array<{ ts: string; ratio: string }>
}

interface OkxResponse {
  code: string
  // New format: data[0].ranks[...], old format: data[...]
  data?: Array<OkxLeadTrader | { ranks: OkxLeadTrader[] }>
  msg?: string
}

export class OkxWeb3Connector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'okx_web3'
  readonly marketType: MarketType = 'web3'

  readonly capabilities: PlatformCapabilities = {
    platform: 'okx_web3',
    market_types: ['web3'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: [
      'Same API as okx_futures with different instType',
      'Period ROI computed from pnlRatios daily series',
      'May be geo-blocked — use VPS proxy',
    ],
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const seen = new Set<string>()
    const allTraders: TraderSource[] = []
    const days = window === '7d' ? 7 : window === '30d' ? 30 : 90

    // MARGIN instType removed (returns 51000 error since ~2026-03)
    for (const instType of ['SWAP']) {
      const maxPages = 50
      for (let page = 1; page <= maxPages; page++) {
        try {
          const url = `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=${instType}&page=${page}`
          const data = await this.request<OkxResponse>(url)

          if (data?.code !== '0') break
          // OKX API wraps traders in data[0].ranks[] (changed ~2026-03)
          const firstItem = data.data?.[0]
          const traders: OkxLeadTrader[] = (firstItem && 'ranks' in firstItem ? (firstItem as { ranks: OkxLeadTrader[] }).ranks : data.data as OkxLeadTrader[]) ?? []
          if (!traders.length) break

          for (const entry of traders) {
            if (seen.has(entry.uniqueCode)) continue
            seen.add(entry.uniqueCode)

            // Compute period ROI from pnlRatios
            const roi = this.computePeriodRoi(entry.pnlRatios, days)
            const mdd = this.computePeriodMdd(entry.pnlRatios, days)

            allTraders.push({
              platform: this.platform,
              market_type: this.marketType,
              trader_key: entry.uniqueCode,
              display_name: entry.nickName || null,
              profile_url: `https://web3.okx.com/copy-trade/account/${entry.uniqueCode}`,
              discovered_at: new Date().toISOString(),
              last_seen_at: new Date().toISOString(),
              is_active: true,
              raw: {
                ...entry as unknown as Record<string, unknown>,
                _computed_roi: roi,
                _computed_mdd: mdd,
                _instType: instType,
              },
            })
          }

          if (traders.length < 10) break
          if (allTraders.length >= limit) break
        } catch (err) {
          if (page === 1 && allTraders.length === 0) throw err
          break
        }
      }
      if (allTraders.length >= limit) break
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
   * Normalize raw OKX Web3 lead trader entry.
   * All API values are strings — parse with safeNumber/safePercent.
   * pnl/totalPnl/accPnl: string PnL values, use first non-null.
   * winRatio: string decimal (0.65 = 65%), ×100 for percentage.
   * copyTraderNum/followerCount: string integers.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as Record<string, unknown>

    return {
      trader_key: e.uniqueCode || null,
      display_name: safeStr(e.nickName),
      avatar_url: safeStr(e.portLink),
      roi: e._computed_roi != null ? safeNumber(e._computed_roi)
        // Fallback: use overall pnlRatio (cumulative) as ROI approximation
        : (e.pnlRatio != null ? safeNumber(Number(e.pnlRatio) * 100) : null),
      pnl: safeNumber(e.pnl ?? e.totalPnl ?? e.accPnl),
      win_rate: safePercent(e.winRatio, { isRatio: true }),
      max_drawdown: e._computed_mdd != null ? safeNumber(e._computed_mdd) : null,
      followers: safeNonNeg(e.copyTraderNum ?? e.followerCount),
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      platform_rank: null,
    }
  }

  /**
   * Compute windowed ROI from OKX cumulative pnlRatios array.
   * pnlRatios is cumulative from inception: (1+last)/(1+first) - 1
   */
  private computePeriodRoi(
    ratios: Array<{ ts: string; ratio: string }> | undefined,
    days: number
  ): number | null {
    if (!ratios || ratios.length === 0) return null

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const sorted = ratios
      .map(r => ({ ts: parseInt(r.ts, 10), ratio: parseFloat(r.ratio) }))
      .filter(r => !isNaN(r.ts) && !isNaN(r.ratio))
      .sort((a, b) => a.ts - b.ts)

    if (sorted.length === 0) return null

    const last = sorted[sorted.length - 1]

    // If only 1 data point, use it as cumulative ROI directly
    if (sorted.length === 1) return last.ratio * 100

    const startIdx = sorted.findIndex(r => r.ts >= cutoff)
    const first = startIdx >= 0 ? sorted[startIdx] : sorted[0]

    if (1 + first.ratio === 0) return null
    return ((1 + last.ratio) / (1 + first.ratio) - 1) * 100
  }

  /**
   * Compute max drawdown from pnlRatios within the window.
   */
  private computePeriodMdd(
    ratios: Array<{ ts: string; ratio: string }> | undefined,
    days: number
  ): number | null {
    if (!ratios || ratios.length < 2) return null

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const values = ratios
      .map(r => ({ ts: parseInt(r.ts, 10), ratio: parseFloat(r.ratio) }))
      .filter(r => r.ts >= cutoff && !isNaN(r.ratio))
      .sort((a, b) => a.ts - b.ts)
      .map(r => 1 + r.ratio)

    if (values.length < 2) return null

    let peak = values[0]
    let maxDd = 0
    for (const v of values) {
      if (v > peak) peak = v
      const dd = peak > 0 ? (peak - v) / peak * 100 : 0
      if (dd > maxDd) maxDd = dd
    }

    return maxDd > 0 ? maxDd : null
  }
}

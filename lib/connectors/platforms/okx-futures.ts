/**
 * OKX Futures Connector
 *
 * Uses OKX's priapi for copy trading leaderboard.
 * Endpoint: www.okx.com/priapi/v5/ecotrade/public/trader-list
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { OkxFuturesLeaderboardResponseSchema } from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('connector:okx-futures')

const V5_WINDOW_MAP: Record<Window, string> = { '7d': '7d', '30d': '30d', '90d': '90d' }

export class OkxFuturesConnector extends BaseConnector {
  readonly platform = 'okx' as const
  readonly marketType = 'futures' as const

  constructor(config?: Partial<import('../types').ConnectorConfig>) {
    // 2026-04-09: maxRetries=0 caused 66h+ data staleness when Vercel hnd1
    // → OKX direct hits an intermittent failure (no retry, no fallback). Bump
    // to maxRetries=2 with the existing exponential backoff. Per-window budget
    // in connector-db-adapter (Phase 1 deadline) caps total time anyway.
    // Timeout bumped 10s→15s to allow retries to land within the page budget.
    super({ timeout: 15000, maxRetries: 2, retryBaseDelay: 1500, ...config })
  }

  readonly capabilities: PlatformCapabilities = {
    platform: 'okx',
    market_types: ['futures', 'copy'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['priapi removed 2026-03, leaderboard-only'],
  }

  async discoverLeaderboard(window: Window, limit = 2000, offset = 0): Promise<DiscoverResult> {
    // v5 copytrading public API (priapi removed 2026-03-14)
    // OKX returns max 20 per page.
    const pageSize = 20
    const maxPages = Math.min(Math.ceil(limit / pageSize), 100)
    const allTraders: TraderSource[] = []

    for (let page = Math.floor(offset / pageSize) + 1; page <= maxPages + Math.floor(offset / pageSize); page++) {
      let _rawLb: Record<string, unknown>
      try {
        _rawLb = await this.request<Record<string, unknown>>(
          `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&sortType=pnl&dataRange=${V5_WINDOW_MAP[window]}&pageNo=${page}&limit=${pageSize}`,
          { method: 'GET' }
        )
      } catch (err) {
        log.warn(`Page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
        break // Stop pagination on error instead of hanging
      }
      const data = warnValidate(OkxFuturesLeaderboardResponseSchema, _rawLb, 'okx-futures/leaderboard')

      // v5 response: { code: "0", data: [{ ranks: [...], totalPage, dataVer }] }
      const dataArr = Array.isArray(data?.data) ? data.data[0] : data?.data
      const list = dataArr?.ranks || []
      if (!Array.isArray(list) || list.length === 0) break

      for (const item of list as Record<string, unknown>[]) {
        allTraders.push({
          platform: 'okx' as const, market_type: 'futures' as const,
          trader_key: String(item.uniqueCode || item.uniqueName || ''),
          display_name: (item.nickName as string) || null,
          profile_url: `https://www.okx.com/copy-trading/account/${item.uniqueCode || item.uniqueName}`,
          discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
          is_active: true, raw: item as Record<string, unknown>,
        })
      }

      if (list.length < pageSize) break
      if (allTraders.length >= limit) break
      await new Promise(r => setTimeout(r, 100))
    }

    return { traders: allTraders.slice(0, limit), total_available: allTraders.length, window, fetched_at: new Date().toISOString() }
  }

  // priapi/v5/ecotrade endpoints were removed by OKX (404 since 2026-03).
  // Profile data is extracted from leaderboard response in normalize() instead.
  // Returning null prevents circuit breaker from tripping on 404s.
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
   * Normalize raw OKX leaderboard entry.
   * Raw fields: uniqueName, nickName, profitRatio (decimal), profit,
   * winRatio (decimal 0-1), copyTraderNum, portLink (avatar), sharpeRatio.
   * MDD computed from pnlRatios in discoverLeaderboard → stored as _computed_mdd.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const winRatio = this.num(raw.winRatio)
    return {
      trader_key: raw.uniqueCode ?? raw.uniqueName ?? null,
      display_name: raw.nickName ?? null,
      avatar_url: raw.portLink ?? null,
      roi: this.decimalToPercent(raw.pnlRatio ?? raw.profitRatio),
      pnl: this.num(raw.pnl ?? raw.profit),
      win_rate: winRatio != null ? (winRatio <= 1 ? winRatio * 100 : winRatio) : null,
      max_drawdown: raw._computed_mdd != null ? Number(raw._computed_mdd) : null,
      trades_count: null,
      followers: this.num(raw.accCopyTraderNum ?? raw.copyTraderNum),
      copiers: this.num(raw.copyTraderNum),
      aum: this.num(raw.aum),
      sharpe_ratio: raw.sharpeRatio != null ? Number(raw.sharpeRatio) : (() => {
        // Fallback: compute Sharpe from pnlRatios (daily ROI curve from leaderboard API)
        const pnlRatios = raw.pnlRatios as Array<{ beginTs?: unknown; pnlRatio?: unknown }> | undefined
        if (!Array.isArray(pnlRatios) || pnlRatios.length < 5) return null
        const roiValues = pnlRatios.map(p => Number(p.pnlRatio)).filter(n => !isNaN(n))
        if (roiValues.length < 5) return null
        const returns = roiValues.slice(1).map((v, i) => v - roiValues[i])
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length
        const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
        if (std <= 0) return null
        const sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
        return Math.max(-10, Math.min(10, sharpe))
      })(),
      platform_rank: null,
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return !Number.isFinite(n) ? null : n
  }

  private decimalToPercent(val: unknown): number | null {
    const n = this.num(val)
    if (n === null) return null
    // OKX returns decimals (0.25 = 25%), convert to percentage
    return Math.abs(n) < 10 ? n * 100 : n
  }
}

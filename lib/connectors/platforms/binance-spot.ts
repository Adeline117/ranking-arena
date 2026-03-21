/**
 * Binance Spot Copy-Trading Connector
 *
 * Uses the new /friendly/ spot-copy-trade API (discovered 2026-03-15).
 * Endpoint: POST /bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list
 *
 * Key notes:
 * - Geo-blocked + AWS WAF protected — requires VPS proxy
 * - 2510 spot traders available
 * - Response includes: roi, pnl, mdd, winRate, sharpRatio, aum, chartItems
 * - trader_key = leadPortfolioId (different from futures encryptedUid)
 */

import { BaseConnector } from '../base'
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

const WINDOW_MAP: Record<Window, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
}

export class BinanceSpotConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'binance_spot'
  readonly marketType: MarketType = 'spot'

  readonly capabilities: PlatformCapabilities = {
    platform: 'binance_spot',
    market_types: ['spot'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: [
      'roi', 'pnl', 'win_rate', 'max_drawdown',
      'followers', 'copiers', 'aum', 'sharpe_ratio',
    ],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 4,
    rate_limit: { rpm: 15, concurrency: 2 },
    notes: [
      'Geo-blocked + AWS WAF — requires VPS proxy',
      '/friendly/ path (not /public/)',
      'trader_key = leadPortfolioId',
      '~2500 spot traders',
    ],
  }

  private readonly BASE_URL = 'https://www.binance.com/bapi/futures'

  private readonly HEADERS = {
    'Content-Type': 'application/json',
    'Origin': 'https://www.binance.com',
    'Referer': 'https://www.binance.com/en/copy-trading/spot',
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    offset: number = 0
  ): Promise<DiscoverResult> {
    const periodType = WINDOW_MAP[window]
    const pageSize = 20
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []
    // Total timeout: 4 minutes — hard cap to prevent cron hangs
    const totalDeadline = Date.now() + 4 * 60 * 1000

    for (let page = Math.floor(offset / pageSize) + 1; page <= maxPages + Math.floor(offset / pageSize); page++) {
      // Bail if approaching total deadline
      if (Date.now() > totalDeadline) break

      const requestBody = {
        pageNumber: page,
        pageSize,
        timeRange: periodType,
        dataType: 'ROI',
        favoriteOnly: false,
        hideFull: false,
        nickname: '',
        order: 'DESC',
        portfolioType: 'ALL',
      }

      let response: Record<string, unknown> | null = null
      const apiUrl = `${this.BASE_URL}/v1/friendly/future/spot-copy-trade/common/home-page-list`

      // Always try VPS proxy first — Binance is geo-blocked from Vercel hnd1
      // Per-page timeout: 30s via proxyViaVPS
      response = await this.proxyViaVPS<Record<string, unknown>>(
        apiUrl,
        { method: 'POST', body: requestBody, headers: this.HEADERS },
        30000
      )

      // Fallback: try direct (works from non-restricted IPs like Mac Mini)
      // Binance success: code = "000000" (string)
      // Binance geo-block: code = 0 (number)
      const hasValidData = response &&
        (response.code === "000000" || (response.data as Record<string, unknown> | null)?.list)

      if (!hasValidData) {
        try {
          response = await this.request<Record<string, unknown>>(
            apiUrl,
            { method: 'POST', headers: this.HEADERS, body: JSON.stringify(requestBody) }
          )
        } catch {
          // Both failed
        }
      }

      if (!response) break

      const data = response.data as Record<string, unknown> | null
      const list = (data?.list || []) as Record<string, unknown>[]
      if (!list.length) break

      for (const entry of list) {
        allTraders.push({
          platform: this.platform,
          market_type: this.marketType,
          trader_key: String(entry.leadPortfolioId || ''),
          display_name: (entry.nickname as string) ?? null,
          profile_url: `https://www.binance.com/en/copy-trading/lead-details?portfolioId=${entry.leadPortfolioId}&type=spot`,
          discovered_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          is_active: true,
          raw: entry,
        })
      }

      if (list.length < pageSize) break
      if (allTraders.length >= limit) break
      await new Promise(r => setTimeout(r, 500))
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
   * Normalize raw Binance Spot leaderboard entry.
   * New API fields: leadPortfolioId, nickname, avatarUrl,
   * roi (%), pnl, mdd (%), winRate (%), sharpRatio, aum, currentCopyCount.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as Record<string, unknown>
    return {
      trader_key: e.leadPortfolioId ?? null,
      display_name: e.nickname ?? null,
      avatar_url: e.avatarUrl ?? null,
      roi: e.roi != null ? Number(e.roi) : null,
      pnl: e.pnl != null ? Number(e.pnl) : null,
      win_rate: e.winRate != null ? Number(e.winRate) : null,
      max_drawdown: e.mdd != null ? Math.abs(Number(e.mdd)) : null,
      trades_count: null,
      followers: e.currentCopyCount != null ? Number(e.currentCopyCount) : null,
      copiers: e.currentCopyCount != null ? Number(e.currentCopyCount) : null,
      aum: e.aum != null ? Number(e.aum) : null,
      // Binance API sharpRatio can return extreme values; reject outside [-10, 10]
      sharpe_ratio: e.sharpRatio != null && Math.abs(Number(e.sharpRatio)) <= 10 ? Number(e.sharpRatio) : null,
      platform_rank: null,
    }
  }
}

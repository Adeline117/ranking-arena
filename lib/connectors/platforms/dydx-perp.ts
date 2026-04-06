/**
 * dYdX v4 Perpetual DEX Connector
 *
 * Uses dYdX v4 indexer API.
 * Endpoint: indexer.dydx.trade/v4/
 *
 * Key notes:
 * - dYdX leaderboard sorts by PnL (not ROI) - we compute ROI client-side
 * - trader_key is a dydx1... or 0x... address
 * - No copy trading / followers / copiers
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  DydxLeaderboardResponseSchema,
  DydxSubaccountResponseSchema,
  DydxHistoricalPnlResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags, TraderTimeseries,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const WINDOW_MAP: Record<Window, string> = { '7d': 'PERIOD_7D', '30d': 'PERIOD_30D', '90d': 'PERIOD_90D' }

/**
 * Resolve dYdX API base URL.
 * Uses Cloudflare Worker proxy (DYDX_PROXY_URL env) to bypass geo-blocking.
 * Falls back to direct indexer if proxy is not configured.
 */
function getDydxBaseUrl(): string {
  const proxyUrl = typeof process !== 'undefined'
    ? (process.env?.DYDX_PROXY_URL || process.env?.CF_WORKER_PROXY_URL)
    : undefined
  return proxyUrl || 'https://indexer.dydx.trade'
}

/** Returns true if we are routing through the CF Worker proxy */
function isUsingProxy(): boolean {
  return !!getDydxBaseUrl() && getDydxBaseUrl() !== 'https://indexer.dydx.trade'
}

export class DydxPerpConnector extends BaseConnector {
  readonly platform = 'dydx' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'dydx',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['pnl'],  // ROI computed client-side
    has_timeseries: true,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 60, concurrency: 3 },
    notes: [
      'Public indexer API',
      'PnL-sorted only (ROI computed)',
      'No profiles',
      'All windows supported',
      'Uses CF Worker proxy to bypass geo-blocking when DYDX_PROXY_URL is set',
    ],
  }

  /**
   * Build the proxied or direct URL for a dYdX indexer endpoint.
   * If CF Worker proxy is configured, routes through /dydx/* shortcuts or /proxy?url=.
   */
  private buildUrl(path: string, params?: Record<string, string>): string {
    const base = getDydxBaseUrl()
    const query = params ? '?' + new URLSearchParams(params).toString() : ''

    if (isUsingProxy()) {
      // CF Worker proxy: use shortcut endpoints or /proxy?url=
      // Shortcut paths: /dydx/leaderboard, /dydx/historical-pnl, /dydx/subaccount
      if (path.startsWith('/v4/leaderboard/pnl')) {
        return `${base}/dydx/leaderboard${query}`
      }
      if (path.startsWith('/v4/historical-pnl')) {
        return `${base}/dydx/historical-pnl${query}`
      }
      if (path.includes('/subaccounts/')) {
        // /v4/addresses/{addr}/subaccounts/{num} → /dydx/subaccount?address=&subaccountNumber=
        const match = path.match(/\/v4\/addresses\/([^/]+)\/subaccounts\/(\d+)/)
        if (match) {
          return `${base}/dydx/subaccount?address=${match[1]}&subaccountNumber=${match[2]}`
        }
      }
      // Fallback: generic /proxy?url= pass-through
      const directUrl = `https://indexer.dydx.trade${path}${query}`
      return `${base}/proxy?url=${encodeURIComponent(directUrl)}`
    }

    // Direct access (no proxy)
    return `https://indexer.dydx.trade${path}${query}`
  }

  async discoverLeaderboard(window: Window, limit = 2000, _offset = 0): Promise<DiscoverResult> {
    // dYdX indexer /v4/leaderboard/pnl returns 404 globally since ~2026-03.
    // Use Copin API as primary data source for trader discovery.
    // Copin API max limit is 500 per page — paginate to reach desired limit.
    // NOTE: Copin leaderboard data has significant processing delay (grew from 3d to 7d+ as of 2026-04).
    // Using Date.now() returns 0 results. Use 7 days ago as queryDate to ensure data availability.
    const statisticType = window === '7d' ? 'WEEK' : 'MONTH'
    const queryDate = Date.now() - 7 * 24 * 60 * 60 * 1000
    const COPIN_PAGE_SIZE = 500

    let traders: TraderSource[] = []

    try {
      let offset = 0
      while (traders.length < limit) {
        const pageSize = Math.min(COPIN_PAGE_SIZE, limit - traders.length)
        const copinUrl = `https://api.copin.io/leaderboards/page?protocol=DYDX&statisticType=${statisticType}&queryDate=${queryDate}&limit=${pageSize}&offset=${offset}&sort_by=ranking&sort_type=asc`

        const copinData = await this.request<Record<string, unknown>>(copinUrl, { method: 'GET' })
        const copinList = (copinData?.data || []) as Record<string, unknown>[]
        if (copinList.length === 0) break

        for (const item of copinList) {
          const address = String(item.account || '')
          traders.push({
            platform: 'dydx' as const, market_type: 'perp' as const,
            trader_key: address,
            display_name: null,
            profile_url: `https://trade.dydx.exchange/portfolio/${address}`,
            discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
            is_active: true, raw: item as Record<string, unknown>,
          })
        }

        // Check if there are more pages
        const meta = copinData?.meta as Record<string, unknown> | undefined
        const total = Number(meta?.total) || 0
        offset += copinList.length
        if (offset >= total || copinList.length < pageSize) break

        // Rate limit between pages
        await this.sleep(300)
      }
    } catch (copinErr) {
      // Fallback: try original indexer API (in case it comes back)
      try {
        const period = WINDOW_MAP[window]
        const url = this.buildUrl('/v4/leaderboard/pnl', { period, limit: String(Math.min(limit, 1000)) })
        const _rawLb = await this.request<Record<string, unknown>>(url, { method: 'GET' })
        const data = warnValidate(DydxLeaderboardResponseSchema, _rawLb, 'dydx-perp/leaderboard')
        const rankings = data?.pnlRanking || []
        traders = (Array.isArray(rankings) ? rankings : []).map((item: Record<string, unknown>) => ({
          platform: 'dydx' as const, market_type: 'perp' as const,
          trader_key: String(item.address || ''),
          display_name: null,
          profile_url: `https://trade.dydx.exchange/portfolio/${item.address}`,
          discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
          is_active: true, raw: item as Record<string, unknown>,
        }))
      } catch {
        // Both Copin and indexer failed
        throw copinErr
      }
    }

    return { traders, total_available: traders.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // dYdX has no user profiles - only addresses
    const profile: TraderProfile = {
      platform: 'dydx', market_type: 'perp', trader_key: traderKey,
      display_name: null, avatar_url: null,
      bio: null, tags: ['on-chain', 'perp-dex'],
      profile_url: `https://trade.dydx.exchange/portfolio/${traderKey}`,
      followers: null, copiers: null, aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: null,
      provenance: { source_platform: 'dydx', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    // Primary: Use Copin API for trader stats (indexer leaderboard endpoint is dead since 2026-03)
    const statisticType = window === '7d' ? 'WEEK' : 'MONTH'
    let pnl: number | null = null
    let roi: number | null = null
    let winRate: number | null = null
    let tradesCount: number | null = null
    let platformRank: number | null = null
    let equity: number | null = null

    try {
      // Fetch from Copin position stats for this trader
      // Copin has ~2 day processing delay — use 3 days ago
      const queryDate = Date.now() - 3 * 24 * 60 * 60 * 1000
      const copinUrl = `https://api.copin.io/leaderboards/page?protocol=DYDX&statisticType=${statisticType}&queryDate=${queryDate}&limit=1000&offset=0&sort_by=ranking&sort_type=asc`
      const copinData = await this.request<Record<string, unknown>>(copinUrl, { method: 'GET' })
      const copinList = (copinData?.data || []) as Record<string, unknown>[]
      const entry = copinList.find((item: Record<string, unknown>) => String(item.account) === traderKey)

      if (entry) {
        pnl = Number(entry.totalPnl ?? entry.totalRealisedPnl) || null
        const totalWin = Number(entry.totalWin) || 0
        const totalLose = Number(entry.totalLose) || 0
        const totalTrade = Number(entry.totalTrade) || (totalWin + totalLose)
        winRate = totalTrade > 0 ? (totalWin / totalTrade) * 100 : null
        tradesCount = totalTrade > 0 ? totalTrade : null
        platformRank = entry.ranking != null ? Number(entry.ranking) : null

        // Estimate ROI from volume with assumed leverage
        const volume = Number(entry.totalVolume) || null
        roi = pnl != null && volume != null && volume > 0
          ? (pnl / (volume / 5)) * 100  // Assume ~5x average leverage
          : null
      }
    } catch {
      // Copin failed, try to get equity from indexer subaccount endpoint
    }

    // Try to get equity from indexer subaccount (may still work)
    try {
      const subUrl = this.buildUrl(`/v4/addresses/${traderKey}/subaccounts/0`)
      const _rawSub = await this.request<Record<string, unknown>>(subUrl, { method: 'GET' })
      const subData = warnValidate(DydxSubaccountResponseSchema, _rawSub, 'dydx-perp/subaccount')
      equity = Number(subData?.subaccount?.equity) || null

      // If we have equity and PnL but no ROI, compute it
      if (roi === null && pnl !== null && equity != null) {
        const startEquity = equity - pnl
        if (startEquity > 0) roi = (pnl / startEquity) * 100
      }
    } catch {
      // Subaccount endpoint also unavailable — continue with Copin data only
    }

    const metrics: SnapshotMetrics = {
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: null,
      sharpe_ratio: null, sortino_ratio: null,
      trades_count: tradesCount,
      followers: null, copiers: null,
      aum: equity,
      platform_rank: platformRank,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }

    const missingFields = ['max_drawdown', 'followers', 'copiers', 'sharpe_ratio', 'sortino_ratio']
    if (winRate === null) missingFields.push('win_rate')
    if (tradesCount === null) missingFields.push('trades_count')

    const quality_flags: QualityFlags = {
      missing_fields: missingFields,
      non_standard_fields: {
        roi: 'Computed from PnL / volume with assumed leverage. dYdX does not provide ROI directly.',
      },
      window_native: true,
      notes: [
        'dYdX is a DEX - no copy trading',
        'Data sourced from Copin.io indexer (dYdX native leaderboard API is dead)',
        'ROI is derived, not platform-provided',
      ],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    const tsUrl = this.buildUrl('/v4/historical-pnl', { address: traderKey, subaccountNumber: '0', limit: '90' })
    const _rawTs = await this.request<Record<string, unknown>>(tsUrl, { method: 'GET' })
    const data = warnValidate(DydxHistoricalPnlResponseSchema, _rawTs, 'dydx-perp/timeseries')
    const historicalPnl = data?.historicalPnl || []

    const series: TraderTimeseries[] = []

    if (Array.isArray(historicalPnl) && historicalPnl.length > 0) {
      series.push({
        platform: 'dydx', market_type: 'perp', trader_key: traderKey,
        series_type: 'daily_pnl', as_of_ts: new Date().toISOString(),
        data: historicalPnl.map((item: Record<string, unknown>) => ({
          ts: String(item.createdAt || new Date().toISOString()),
          value: Number(item.totalPnl) || 0,
        })).reverse(),  // API returns newest first
        updated_at: new Date().toISOString(),
      })

      // Compute equity curve from cumulative PnL
      let cumPnl = 0
      series.push({
        platform: 'dydx', market_type: 'perp', trader_key: traderKey,
        series_type: 'equity_curve', as_of_ts: new Date().toISOString(),
        data: historicalPnl.reverse().map((item: Record<string, unknown>) => {
          cumPnl += Number(item.totalPnl) || 0
          return { ts: String(item.createdAt || new Date().toISOString()), value: cumPnl }
        }),
        updated_at: new Date().toISOString(),
      })
    }

    return { series, fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // Supports both indexer format (address, pnl) and Copin format (account, totalPnl, totalWin, etc.)
    const totalWin = Number(raw.totalWin) || 0
    const totalLose = Number(raw.totalLose) || 0
    const totalTrade = Number(raw.totalTrade) || (totalWin + totalLose)
    const winRate = totalTrade > 0 ? (totalWin / totalTrade) * 100 : null

    const pnl = Number(raw.totalPnl ?? raw.totalRealisedPnl ?? raw.pnl) || null
    const volume = Number(raw.totalVolume) || null
    // Estimate ROI from PnL/Volume with assumed leverage
    const roi = pnl != null && volume != null && volume > 0
      ? (pnl / (volume / 5)) * 100  // Assume ~5x average leverage
      : null

    return {
      trader_key: String(raw.account || raw.address || ''),
      display_name: null,
      avatar_url: null,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: null, // Copin doesn't provide MDD
      trades_count: totalTrade > 0 ? totalTrade : null,
      followers: null,
      copiers: null,
      aum: null,
      sharpe_ratio: null,
      platform_rank: raw.ranking != null ? Number(raw.ranking) : (raw.rank != null ? Number(raw.rank) : null),
    }
  }
}

/**
 * Crypto.com Futures Connector
 *
 * Fetches copy-trading leaderboard from Crypto.com's exchange.
 * Crypto.com uses Cloudflare JS challenge, so direct API calls fail
 * from datacenter IPs. Uses VPS Playwright scraper as primary strategy.
 *
 * The copy trading page is at: https://crypto.com/exchange/copy-trading
 * API endpoints are not publicly documented — scraper intercepts XHR calls
 * made by the SPA after Cloudflare challenge is solved.
 *
 * Known API patterns (discovered via browser interception):
 * - GET/POST https://crypto.com/fe-ex-api/copy_trade/get_lead_trader_leaderboard
 * - GET/POST https://crypto.com/fe-ex-api/copy_trade/get_lead_trader_list
 * - Response format TBD — scraper will capture whatever the page loads
 *
 * Notes:
 * - Cloudflare JS challenge blocks all direct/proxy requests (403)
 * - VPS Playwright scraper required (scraper_sg only)
 * - ROI format unknown — normalize() handles both ratio and percentage
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

interface CryptoComTraderEntry {
  // Identity fields (multiple possible key names)
  trader_id?: string
  traderId?: string
  lead_trader_id?: string
  leadTraderId?: string
  uid?: string
  user_id?: string
  userId?: string
  id?: string
  // Display info
  name?: string
  nickname?: string
  nickName?: string
  display_name?: string
  displayName?: string
  avatar?: string
  avatar_url?: string
  avatarUrl?: string
  // Performance metrics
  roi?: number
  pnl?: number
  profit?: number
  total_pnl?: number
  totalPnl?: number
  profit_ratio?: number
  profitRatio?: number
  return_rate?: number
  returnRate?: number
  // Risk metrics
  win_rate?: number
  winRate?: number
  max_drawdown?: number
  maxDrawdown?: number
  mdd?: number
  sharpe_ratio?: number
  sharpeRatio?: number
  // Social metrics
  followers?: number
  follower_count?: number
  followerCount?: number
  copiers?: number
  copier_count?: number
  copierCount?: number
  // Trading metrics
  trades_count?: number
  tradesCount?: number
  trade_count?: number
  tradeCount?: number
  aum?: number
  // Rank
  rank?: number
}

export class CryptoFuturesConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'crypto_com' as LeaderboardPlatform
  readonly marketType: MarketType = 'futures'

  readonly capabilities: PlatformCapabilities = {
    platform: 'crypto_com' as LeaderboardPlatform,
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 4,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: [
      'Cloudflare JS challenge blocks direct API access',
      'VPS Playwright scraper required',
      'API endpoints not publicly documented',
      'ROI format TBD — handles both ratio and percentage',
    ],
  }

  private mapWindowToParam(window: Window): string {
    const m: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const period = this.mapWindowToParam(window)
    const seen = new Set<string>()
    const allTraders: TraderSource[] = []

    // Strategy 1: VPS Playwright scraper (primary — Cloudflare blocks everything else)
    try {
      const vpsData = await this.fetchViaVPS<Record<string, unknown>>(
        `/crypto_com/leaderboard`,
        { period, pageSize: '100' },
        120000 // 2min timeout — Cloudflare challenge + page load can be slow
      )

      if (vpsData) {
        const traderList = this.extractTraderList(vpsData)
        if (traderList.length) {
          for (const entry of traderList) {
            const id = this.extractId(entry)
            if (!id || seen.has(id)) continue
            seen.add(id)
            allTraders.push(this.toTraderSource(entry, id))
          }
        }
      }
    } catch {
      // VPS scraper failed — fall through to direct API attempts
    }

    // Strategy 2: Direct API (unlikely to work from datacenter, but try common patterns)
    if (allTraders.length < 10) {
      const apiEndpoints = [
        `https://crypto.com/fe-ex-api/copy_trade/get_lead_trader_leaderboard`,
        `https://crypto.com/fe-ex-api/copy_trade/get_lead_trader_list`,
      ]

      for (const endpoint of apiEndpoints) {
        try {
          // Try GET with query params
          const data = await this.request<Record<string, unknown>>(
            `${endpoint}?page=1&page_size=100&period=${period}&sort_by=roi`,
          )
          const traders = this.extractTraderList(data ?? {})
          for (const entry of traders) {
            const id = this.extractId(entry)
            if (!id || seen.has(id)) continue
            seen.add(id)
            allTraders.push(this.toTraderSource(entry, id))
          }
          if (allTraders.length >= 10) break
        } catch {
          // Expected to fail with 403 from Cloudflare
        }

        // Try POST variant
        try {
          const data = await this.proxyViaVPS<Record<string, unknown>>(
            endpoint,
            {
              method: 'POST',
              body: { page: 1, page_size: 100, period: parseInt(period), sort_by: 'roi' },
              headers: { 'Content-Type': 'application/json' },
            },
            30000
          )
          if (data) {
            const traders = this.extractTraderList(data)
            for (const entry of traders) {
              const id = this.extractId(entry)
              if (!id || seen.has(id)) continue
              seen.add(id)
              allTraders.push(this.toTraderSource(entry, id))
            }
          }
          if (allTraders.length >= 10) break
        } catch {
          // VPS proxy also failed
        }
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
   * Normalize raw Crypto.com leaderboard entry.
   * ROI format is unknown — we detect ratio vs percentage:
   * - If |roi| < 10, assume ratio (multiply by 100)
   * - If |roi| >= 10, assume already percentage
   * This heuristic works for most traders (>1000% ROI is rare in 7-90d windows)
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as CryptoComTraderEntry

    // ROI: try all possible field names
    const rawRoi = e.roi ?? e.profit_ratio ?? e.profitRatio ?? e.return_rate ?? e.returnRate
    // Detect if ratio or percentage: values < 10 are likely ratios (e.g., 0.5 = 50%)
    const isRatio = rawRoi !== null && rawRoi !== undefined && Math.abs(Number(rawRoi)) < 10
    const roi = safePercent(rawRoi, { isRatio })

    // Win rate: typically 0-1 ratio or 0-100 percentage
    const rawWinRate = e.win_rate ?? e.winRate
    const winRateIsRatio = rawWinRate !== null && rawWinRate !== undefined && Number(rawWinRate) <= 1
    const winRate = safePercent(rawWinRate, { isRatio: winRateIsRatio })

    // Max drawdown
    const rawMdd = e.max_drawdown ?? e.maxDrawdown ?? e.mdd
    const mddIsRatio = rawMdd !== null && rawMdd !== undefined && Math.abs(Number(rawMdd)) <= 1
    const maxDrawdown = safeMdd(rawMdd, mddIsRatio)

    return {
      trader_key: this.extractId(e),
      display_name: safeStr(e.name ?? e.nickname ?? e.nickName ?? e.display_name ?? e.displayName),
      avatar_url: safeStr(e.avatar ?? e.avatar_url ?? e.avatarUrl),
      roi,
      pnl: safeNumber(e.pnl ?? e.profit ?? e.total_pnl ?? e.totalPnl),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers: safeNonNeg(e.followers ?? e.follower_count ?? e.followerCount),
      sharpe_ratio: safeNumber(e.sharpe_ratio ?? e.sharpeRatio),
      trades_count: safeNonNeg(e.trades_count ?? e.tradesCount ?? e.trade_count ?? e.tradeCount),
      aum: safeNumber(e.aum),
      copiers: safeNonNeg(e.copiers ?? e.copier_count ?? e.copierCount),
      platform_rank: safeNonNeg(e.rank),
    }
  }

  /**
   * Extract trader list from various possible response shapes.
   * Crypto.com API format is unknown — try common patterns.
   */
  private extractTraderList(data: Record<string, unknown>): CryptoComTraderEntry[] {
    if (!data) return []

    // Direct array
    if (Array.isArray(data)) return data as CryptoComTraderEntry[]

    // Common response wrapper patterns
    const candidates = [
      // { data: { list: [...] } }
      (data.data as Record<string, unknown>)?.list,
      // { data: { traders: [...] } }
      (data.data as Record<string, unknown>)?.traders,
      // { data: { rows: [...] } }
      (data.data as Record<string, unknown>)?.rows,
      // { data: { items: [...] } }
      (data.data as Record<string, unknown>)?.items,
      // { data: { leaderboard: [...] } }
      (data.data as Record<string, unknown>)?.leaderboard,
      // { result: { list: [...] } }
      (data.result as Record<string, unknown>)?.list,
      // { result: { traders: [...] } }
      (data.result as Record<string, unknown>)?.traders,
      // { result: [...] }
      data.result,
      // { data: [...] }
      data.data,
      // { list: [...] }
      data.list,
      // { traders: [...] }
      data.traders,
      // { rows: [...] }
      data.rows,
      // { items: [...] }
      data.items,
      // { leaderboard: [...] }
      data.leaderboard,
    ]

    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length > 0) {
        return candidate as CryptoComTraderEntry[]
      }
    }

    return []
  }

  private extractId(e: CryptoComTraderEntry): string | null {
    const id = e.trader_id || e.traderId || e.lead_trader_id || e.leadTraderId ||
               e.uid || e.user_id || e.userId || e.id
    return id ? String(id) : null
  }

  private toTraderSource(entry: CryptoComTraderEntry, id: string): TraderSource {
    return {
      platform: this.platform,
      market_type: this.marketType,
      trader_key: id,
      display_name: entry.name || entry.nickname || entry.nickName || entry.display_name || entry.displayName || null,
      profile_url: `https://crypto.com/exchange/copy-trading/trader/${id}`,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: entry as unknown as Record<string, unknown>,
    }
  }
}

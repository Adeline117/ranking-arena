/**
 * Gains Network (gTrade) Perpetual Connector
 *
 * Uses Gains Network's REST API and subgraph for trader stats.
 *
 * Key notes:
 * - trader_key is wallet address on Arbitrum
 * - Has REST API: /open-trades, /personal-trading-history-table/<address>
 * - Also has GraphQL subgraph on Arbitrum
 * - No followers/copiers (DEX - no copy trading)
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  GainsOpenTradesResponseSchema,
  GainsTradeHistoryResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface GainsTrade {
  trader?: string
  pairIndex?: number
  index?: number
  leverage?: number
  collateralAmount?: number
  openPrice?: number
  tp?: number
  sl?: number
  timestamp?: number
}

interface GainsTradeHistory {
  address?: string
  pnl?: number
  pnlPercent?: number
  action?: string
  pair?: string
  leverage?: number
  collateral?: number
  date?: string
}

export class GainsPerpConnector extends BaseConnector {
  readonly platform = 'gains' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'gains',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'trades_count'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2, // REST API + subgraph available
    rate_limit: { rpm: 30, concurrency: 5 },
    notes: ['Arbitrum DEX', 'gTrade platform', 'REST API available', 'No copy trading', 'Metrics calculated from trade history'],
  }

  private readonly API_BASE = 'https://backend-arbitrum.gains.trade'
  private readonly SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/gainsnetwork-org/gtrade-stats-arbitrum'

  private getHeaders(): Record<string, string> {
    return {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  }

  /**
   * Discover traders from Gains leaderboard API across 3 chains.
   * Uses /leaderboard endpoint (ranked by performance) instead of /open-trades
   * to match inline fetcher behavior.
   */
  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    const chains = ['arbitrum', 'polygon', 'base']
    const seen = new Set<string>()
    const allTraders: TraderSource[] = []

    for (const chain of chains) {
      try {
        const data = await this.request<Array<Record<string, unknown>>>(
          `https://backend-${chain}.gains.trade/leaderboard`,
          { method: 'GET', headers: this.getHeaders() }
        )

        if (!Array.isArray(data)) continue

        for (const entry of data) {
          const address = String(entry.address || entry.trader || '').toLowerCase()
          if (!address || seen.has(address)) continue
          seen.add(address)

          allTraders.push({
            platform: 'gains',
            market_type: 'perp' as const,
            trader_key: address,
            display_name: `${address.slice(0, 6)}...${address.slice(-4)}`,
            profile_url: `https://gains.trade/trader/${address}`,
            discovered_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            is_active: true,
            raw: { ...entry, _chain: chain },
          })

          if (allTraders.length >= limit) break
        }
      } catch (err) {
        if (allTraders.length === 0 && chain === chains[chains.length - 1]) throw err
        // Continue with other chains
      }
      if (allTraders.length >= limit) break
    }

    return { traders: allTraders.slice(0, limit), total_available: allTraders.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const profile: TraderProfile = {
        platform: 'gains',
        market_type: 'perp',
        trader_key: traderKey.toLowerCase(),
        display_name: `${traderKey.slice(0, 6)}...${traderKey.slice(-4)}`,
        avatar_url: null,
        bio: null,
        tags: ['arbitrum', 'perpetual', 'gtrade'],
        profile_url: `https://gains.trade/trader/${traderKey}`,
        followers: null,
        copiers: null,
        aum: null,
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'gains',
          acquisition_method: 'api',
          fetched_at: new Date().toISOString(),
          source_url: this.API_BASE,
          scraper_version: '1.0.0',
        },
      }
      return { profile, fetched_at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    try {
      // Get trader's open positions
      const _rawOpenTrades = await this.request<GainsTrade[]>(
        `${this.API_BASE}/open-trades/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const openTrades = warnValidate(GainsOpenTradesResponseSchema, _rawOpenTrades, 'gains-perp/open-trades')

      // Get trading history
      const _rawHistory = await this.request<GainsTradeHistory[]>(
        `${this.API_BASE}/personal-trading-history-table/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const history = warnValidate(GainsTradeHistoryResponseSchema, _rawHistory, 'gains-perp/history')

      // Calculate stats from history within the window
      let totalPnl = 0
      let totalCollateral = 0
      let totalTrades = 0
      let winningTrades = 0
      let maxEquity = 0
      let minEquityFromPeak = 0
      let runningEquity = 0

      const now = new Date()
      const windowDays = window === '7d' ? 7 : window === '30d' ? 30 : 90

      // Sort history by date ascending for drawdown calculation
      const sortedHistory = (history || [])
        .filter(trade => {
          if (!trade.date) return false
          const tradeDate = new Date(trade.date)
          const daysDiff = (now.getTime() - tradeDate.getTime()) / (1000 * 60 * 60 * 24)
          return daysDiff <= windowDays
        })
        .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime())

      for (const trade of sortedHistory) {
        const pnl = trade.pnl || 0
        const collateral = trade.collateral || 0

        totalPnl += pnl
        totalCollateral += collateral
        totalTrades++

        if (pnl > 0) {
          winningTrades++
        }

        // Track equity curve for drawdown calculation
        runningEquity += pnl
        if (runningEquity > maxEquity) {
          maxEquity = runningEquity
        }
        const drawdownFromPeak = maxEquity - runningEquity
        if (drawdownFromPeak > minEquityFromPeak) {
          minEquityFromPeak = drawdownFromPeak
        }
      }

      // Calculate ROI: totalPnl / totalCollateral * 100
      const roi = totalCollateral > 0 ? (totalPnl / totalCollateral) * 100 : null

      // Calculate win rate
      const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : null

      // Calculate max drawdown as percentage of peak equity
      const maxDrawdown = maxEquity > 0 ? (minEquityFromPeak / maxEquity) * 100 : null

      const metrics: SnapshotMetrics = {
        roi,
        pnl: totalPnl || null,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: totalTrades || null,
        followers: null,
        copiers: null,
        aum: null,
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const missingFields: string[] = ['sharpe_ratio', 'sortino_ratio', 'followers', 'copiers', 'aum']
      if (roi === null) missingFields.push('roi')
      if (winRate === null) missingFields.push('win_rate')
      if (maxDrawdown === null) missingFields.push('max_drawdown')

      const quality_flags: QualityFlags = {
        missing_fields: missingFields,
        non_standard_fields: { open_positions: String(openTrades?.length || 0) },
        window_native: true,
        notes: ['Gains Network Arbitrum DEX', `${openTrades?.length || 0} open positions`, 'ROI/WinRate/MDD calculated from trade history'],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch {
      return {
        metrics: this.emptyMetrics(),
        quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: false, notes: ['API error or trader not found'] },
        fetched_at: new Date().toISOString(),
      }
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw Gains leaderboard entry.
   * Raw fields: address/trader, total_pnl_usd/total_pnl/pnl,
   * count_win/count (for win_rate), count (trades), avg_win, avg_loss,
   * avgPositionSize. ROI estimated from PnL / (avgPositionSize × trades).
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const pnl = this.num(raw.total_pnl_usd ?? raw.total_pnl ?? raw.pnl)
    const wins = this.num(raw.count_win) ?? 0
    const losses = this.num(raw.count_loss) ?? 0
    const total = this.num(raw.count ?? raw.totalTrades) ?? 0
    const winRate = total > 0 ? (wins / total) * 100 : null
    // ROI from API fields (may be returned directly)
    let roi = this.num(raw.roi ?? raw.pnlPercent ?? raw.returnRate ?? raw.profitPercent)
    // Convert from decimal ratio (0.15 = 15%) if needed
    if (roi != null && Math.abs(roi) < 10 && total > 10) roi = roi * 100
    // Fallback: estimate ROI from PnL / (avgPositionSize × totalTrades)
    if (roi === null) {
      const avgPos = this.num(raw.avgPositionSize)
      if (pnl != null && avgPos != null && total > 0 && avgPos > 0) {
        roi = Math.max(-100, Math.min(10000, (pnl / (avgPos * total)) * 100))
      }
    }
    // Fallback 2: estimate ROI using abs(avg_loss) as capital proxy per trade
    // Rationale: avg_loss represents average risk per trade, approximating position size
    if (roi === null && pnl != null && total > 0) {
      const avgLossVal = this.num(raw.avg_loss)
      const avgWinVal = this.num(raw.avg_win)
      // Use max(abs(avg_loss), avg_win) as proxy for average position size
      const capitalProxy = Math.max(
        avgLossVal != null ? Math.abs(avgLossVal) : 0,
        avgWinVal != null ? avgWinVal : 0
      )
      if (capitalProxy > 0) {
        // ROI = totalPnL / (estimated total capital deployed)
        const totalCapital = capitalProxy * total
        roi = Math.max(-500, Math.min(10000, (pnl / totalCapital) * 100))
      }
    }

    // MDD approximation from avg_loss, count_loss, avg_win, count_win
    // Estimated peak equity = total winnings = avg_win * count_win
    // Estimated max drawdown = total losses / (total winnings + total losses) * 100
    const avgWin = this.num(raw.avg_win)
    const avgLoss = this.num(raw.avg_loss)
    let maxDrawdown: number | null = null
    if (avgLoss != null && losses > 0 && avgWin != null && wins > 0) {
      const totalLosses = Math.abs(avgLoss) * losses
      const totalWins = avgWin * wins
      const peakEquity = totalWins + totalLosses // gross capital at risk
      if (peakEquity > 0) {
        const mdd = (totalLosses / peakEquity) * 100
        if (mdd > 0.01 && mdd <= 100) {
          maxDrawdown = Math.round(mdd * 100) / 100
        }
      }
    }

    return {
      trader_key: String(raw.address ?? raw.trader ?? '').toLowerCase(),
      display_name: null,
      avatar_url: null,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: total > 0 ? total : null,
      followers: null,
      copiers: null,
      aum: null,
      sharpe_ratio: null,
      platform_rank: null,
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

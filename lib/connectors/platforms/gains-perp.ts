/**
 * Gains Network (gTrade) Perpetual Connector
 *
 * Uses Gains Network's REST API and subgraph for trader stats.
 *
 * Key notes:
 * - trader_key is wallet address on Arbitrum
 * - Has REST API: /leaderboard (aggregate stats per trader)
 * - personal-trading-history-table endpoint removed (404 since 2026-04)
 * - Stats computed from leaderboard data: count, count_win, count_loss, avg_win, avg_loss, total_pnl
 * - No followers/copiers (DEX - no copy trading)
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

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
  async discoverLeaderboard(window: Window, limit = 2000, _offset = 0): Promise<DiscoverResult> {
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
    } catch (err) {
      this.logger.debug('Gains profile fetch failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    try {
      // Compute stats from leaderboard data (which contains aggregate fields).
      // The personal-trading-history-table endpoint was removed (404 since 2026-04).
      // Instead, search the leaderboard for this trader's aggregate stats.
      const chains = ['arbitrum', 'polygon', 'base']
      let traderData: Record<string, unknown> | null = null

      for (const chain of chains) {
        try {
          const data = await this.request<Array<Record<string, unknown>>>(
            `https://backend-${chain}.gains.trade/leaderboard`,
            { method: 'GET', headers: this.getHeaders() }
          )
          if (!Array.isArray(data)) continue
          const found = data.find(
            (e) => String(e.address || e.trader || '').toLowerCase() === traderKey.toLowerCase()
          )
          if (found) {
            traderData = found
            break
          }
        } catch (err) {
          this.logger.debug('Gains chain leaderboard fallback:', err instanceof Error ? err.message : String(err))
          continue
        }
      }

      if (!traderData) {
        return null
      }

      // Use normalize() to extract standard fields
      const normalized = this.normalize(traderData)

      const metrics: SnapshotMetrics = {
        roi: normalized.roi as number | null,
        pnl: normalized.pnl as number | null,
        win_rate: normalized.win_rate as number | null,
        max_drawdown: normalized.max_drawdown as number | null,
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: normalized.trades_count as number | null,
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
      if (metrics.roi === null) missingFields.push('roi')
      if (metrics.win_rate === null) missingFields.push('win_rate')
      if (metrics.max_drawdown === null) missingFields.push('max_drawdown')

      const quality_flags: QualityFlags = {
        missing_fields: missingFields,
        non_standard_fields: {},
        window_native: false,
        notes: ['Gains Network DEX', 'Stats from leaderboard aggregate data'],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch (err) {
      this.logger.debug('Gains snapshot fetch failed:', err instanceof Error ? err.message : String(err))
      return null
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
    const winRate = total > 0 ? Math.min((wins / total) * 100, 100) : null
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
    // Fallback 3: ROI from totalPnl / totalVolume (Gains leaderboard may include volume)
    if (roi === null && pnl != null) {
      const volume = this.num(raw.totalVolume ?? raw.total_volume ?? raw.volume ?? raw.totalCollateral)
      if (volume != null && volume > 0) {
        roi = Math.max(-500, Math.min(10000, (pnl / volume) * 100))
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

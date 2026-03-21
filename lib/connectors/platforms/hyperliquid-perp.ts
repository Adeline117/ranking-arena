/**
 * Hyperliquid Perpetual DEX Connector
 *
 * Uses Hyperliquid's public REST API.
 * Endpoint: api.hyperliquid.xyz/info
 *
 * Key differences from CEX:
 * - trader_key is an Ethereum address (0x...)
 * - No copy trading / followers / copiers
 * - ROI computed from account value changes
 * - Win rate computed from trade fills
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  HyperliquidLeaderboardResponseSchema,
  HyperliquidClearinghouseResponseSchema,
  HyperliquidFillsResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags, TraderTimeseries,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class HyperliquidPerpConnector extends BaseConnector {
  readonly platform = 'hyperliquid' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'hyperliquid',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl'],
    has_timeseries: true,
    has_profiles: false,  // No user profiles on DEX
    scraping_difficulty: 1,
    rate_limit: { rpm: 60, concurrency: 3 },
    notes: ['Public REST API', 'No CF', 'trader_key = 0x address', 'No followers/copiers/win_rate natively'],
  }

  async discoverLeaderboard(window: Window, limit = 500, _offset = 0): Promise<DiscoverResult> {
    // Primary: stats-data endpoint (GET, always works)
    // Fallback: info POST endpoint (broke ~2026-03-14, returns 422)
    let _rawLb: Record<string, unknown>
    try {
      _rawLb = await this.request<Record<string, unknown>>(
        'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',
        { method: 'GET' }
      )
    } catch {
      // Fallback to POST info endpoint
      const timeWindow = window === '7d' ? 'day' : window === '30d' ? 'month' : 'allTime'
      _rawLb = await this.request<Record<string, unknown>>(
        'https://api.hyperliquid.xyz/info',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'leaderboard', timeWindow }),
        }
      )
    }
    const data = warnValidate(HyperliquidLeaderboardResponseSchema, _rawLb, 'hyperliquid-perp/leaderboard')
    const leaderboard = data?.leaderboardRows || data || []

    // For 90d with allTime, we take top entries (platform doesn't have 90d natively, uses allTime)
    const entries = Array.isArray(leaderboard) ? leaderboard.slice(0, limit) : []

    // Map window to windowPerformances key — stats-data returns 'day'/'week'/'month'/'allTime'
    const windowKey = window === '7d' ? 'week' : window === '30d' ? 'month' : 'allTime'

    const traders: TraderSource[] = entries.map((item: Record<string, unknown>) => {
      const address = String(item.ethAddress || item.user || '')
      // Extract ROI/PnL from windowPerformances for the requested window.
      // windowPerformances can be either:
      //   - An array of tuples: [["day", {pnl, roi, vlm}], ["week", ...], ...]  (stats-data endpoint)
      //   - An object: { day: {pnl, roi, vlm}, week: ..., ... }                 (info endpoint)
      let perf: Record<string, unknown> | undefined
      const wp = item.windowPerformances
      if (Array.isArray(wp)) {
        // Array of [key, value] tuples
        const entry = wp.find((pair: unknown) => Array.isArray(pair) && pair[0] === windowKey)
        perf = entry ? (entry as [string, Record<string, unknown>])[1] : undefined
      } else if (wp && typeof wp === 'object') {
        // Object keyed by window name
        perf = (wp as Record<string, Record<string, unknown>>)[windowKey]
      }
      const rawRoi = perf?.roi != null ? Number(perf.roi) : null
      const rawPnl = perf?.pnl != null ? Number(perf.pnl) : null
      // Hyperliquid API returns ROI as decimal (0.35 = 35%) but occasionally as percentage (35 = 35%)
      // Smart detection: if |roi| <= 10, treat as decimal and multiply; otherwise already percentage
      const roi = rawRoi != null ? (Math.abs(rawRoi) <= 10 ? rawRoi * 100 : rawRoi) : null
      // Anomaly fix: if roi ≈ pnl (wrong scale), recalculate
      const accountValue = item.accountValue != null ? Number(item.accountValue) : null
      let correctedRoi = (roi != null && rawPnl != null && accountValue != null
        && Math.abs(roi - rawPnl) < 1 && accountValue > 0)
        ? (rawPnl / accountValue) * 100
        : roi
      // Cap extreme ROI values (Arena Score caps at 10000% internally anyway)
      if (correctedRoi != null && correctedRoi > 10000) correctedRoi = 10000

      return {
        platform: 'hyperliquid' as const, market_type: 'perp' as const,
        trader_key: address,
        display_name: (item.displayName as string) || null,
        profile_url: `https://app.hyperliquid.xyz/leaderboard/${address}`,
        discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: {
          ...item as Record<string, unknown>,
          _computed_roi: correctedRoi,
          _computed_pnl: rawPnl,
        },
      }
    })

    return { traders, total_available: entries.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // Hyperliquid has no user profiles - only addresses
    const profile: TraderProfile = {
      platform: 'hyperliquid', market_type: 'perp', trader_key: traderKey,
      display_name: null,  // Anonymous wallet
      avatar_url: null,
      bio: null, tags: ['on-chain', 'perp-dex'],
      profile_url: `https://app.hyperliquid.xyz/leaderboard/${traderKey}`,
      followers: null, copiers: null, aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: null,
      provenance: { source_platform: 'hyperliquid', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    // Fetch leaderboard for the requested window to get accurate ROI
    const timeWindow = window === '7d' ? 'day' : window === '30d' ? 'month' : 'allTime'

    const [_rawState, _rawLb] = await Promise.all([
      // Get clearinghouse state for current equity / AUM
      this.request<Record<string, unknown>>(
        'https://api.hyperliquid.xyz/info',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'clearinghouseState', user: traderKey }),
        }
      ),
      // Get leaderboard to look up the trader's windowed ROI
      this.request<Record<string, unknown>>(
        'https://api.hyperliquid.xyz/info',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'leaderboard', timeWindow }),
        }
      ),
    ])

    const state = warnValidate(HyperliquidClearinghouseResponseSchema, _rawState, 'hyperliquid-perp/clearinghouse')
    const lbData = warnValidate(HyperliquidLeaderboardResponseSchema, _rawLb, 'hyperliquid-perp/leaderboard-snapshot')

    const accountValue = Number(state?.marginSummary?.accountValue) || 0
    const totalRawPnl = Number(state?.marginSummary?.totalRawPnl) || 0

    // Look up the trader's ROI from the leaderboard (accurate per-window value)
    const leaderboardRows = lbData?.leaderboardRows || []
    const traderKeyLower = traderKey.toLowerCase()
    const lbEntry = Array.isArray(leaderboardRows)
      ? leaderboardRows.find((row: Record<string, unknown>) => {
          const addr = String(row.ethAddress || '').toLowerCase()
          return addr === traderKeyLower
        })
      : undefined

    let roi: number | null = null
    if (lbEntry && lbEntry.roi != null) {
      // Hyperliquid API returns ROI as decimal (0.35 = 35%) or occasionally as percentage
      const rawRoi = Number(lbEntry.roi)
      roi = Math.abs(rawRoi) <= 10 ? rawRoi * 100 : rawRoi
    } else if (accountValue > 0 && totalRawPnl !== 0) {
      // Fallback: approximate ROI from clearinghouse state
      roi = (totalRawPnl / (accountValue - totalRawPnl)) * 100
    }

    // Compute win_rate and max_drawdown from fills (closedPnl per trade)
    let winRate: number | null = null
    let fillMDD: number | null = null
    try {
      const _rawFills = await this.request<Record<string, unknown>>(
        'https://api.hyperliquid.xyz/info',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFills', user: traderKey }),
        }
      )
      const fills = Array.isArray(_rawFills) ? _rawFills : []
      if (fills.length > 0) {
        const closedFills = fills.filter((f: Record<string, unknown>) => Number(f.closedPnl) !== 0)
        const wins = closedFills.filter((f: Record<string, unknown>) => Number(f.closedPnl) > 0).length
        if (closedFills.length > 0) winRate = (wins / closedFills.length) * 100

        // MDD from cumulative PnL of closed fills
        let cumPnl = 0
        let peak = 0
        let maxDD = 0
        for (const f of closedFills) {
          cumPnl += Number((f as Record<string, unknown>).closedPnl) || 0
          if (cumPnl > peak) peak = cumPnl
          if (peak > 0) {
            const dd = ((peak - cumPnl) / peak) * 100
            if (dd > maxDD) maxDD = dd
          }
        }
        if (maxDD > 0.01 && maxDD < 200) fillMDD = Math.round(maxDD * 100) / 100
      }
    } catch {
      // Fills fetch is non-critical for snapshot
    }

    const metrics: SnapshotMetrics = {
      roi,
      pnl: totalRawPnl || null,
      win_rate: winRate,
      max_drawdown: fillMDD,  // Computed from cumulative fills PnL
      sharpe_ratio: null, sortino_ratio: null,
      trades_count: null,
      followers: null,  // DEX - no followers
      copiers: null,    // DEX - no copiers
      aum: accountValue || null,
      platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }

    const quality_flags: QualityFlags = {
      missing_fields: ['followers', 'copiers', 'sharpe_ratio', 'sortino_ratio'],
      non_standard_fields: {
        roi: 'Sourced from leaderboard endpoint (per-window). Falls back to clearinghouse approximation if trader not on leaderboard.',
      },
      window_native: window === '30d',  // Only 'month' is truly native
      notes: [
        'Hyperliquid is a DEX - no copy trading features',
        'ROI sourced from leaderboard when available, falls back to clearinghouse approximation',
        'Win rate requires trade-level analysis of fills',
      ],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    // Get user fills for trade history
    const _rawFills = await this.request<Record<string, unknown>>(
      'https://api.hyperliquid.xyz/info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFills', user: traderKey }),
      }
    )
    const fills = warnValidate(HyperliquidFillsResponseSchema, _rawFills, 'hyperliquid-perp/fills')

    const series: TraderTimeseries[] = []

    if (Array.isArray(fills) && fills.length > 0) {
      // Aggregate fills by day for daily PnL
      const dailyPnl = new Map<string, number>()
      for (const fill of fills) {
        const date = new Date(Number(fill.time) || Date.now()).toISOString().split('T')[0]
        const pnl = Number(fill.closedPnl) || 0
        dailyPnl.set(date, (dailyPnl.get(date) || 0) + pnl)
      }

      series.push({
        platform: 'hyperliquid', market_type: 'perp', trader_key: traderKey,
        series_type: 'daily_pnl', as_of_ts: new Date().toISOString(),
        data: Array.from(dailyPnl.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, value]) => ({ ts: `${date}T00:00:00Z`, value })),
        updated_at: new Date().toISOString(),
      })
    }

    return { series, fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw Hyperliquid leaderboard entry.
   * Raw fields: ethAddress/user, displayName, accountValue (equity/AUM — NOT PnL),
   * windowPerformances (keyed by window: week/month/allTime with roi/pnl).
   *
   * IMPORTANT: accountValue is total equity (AUM), not PnL.
   * ROI and PnL come from windowPerformances, stored as _computed_roi/_computed_pnl
   * by discoverLeaderboard().
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // Extract window-specific ROI/PnL if pre-computed in discover
    const roi = raw._computed_roi != null ? Number(raw._computed_roi) : null
    const pnl = raw._computed_pnl != null ? Number(raw._computed_pnl) : null
    const accountValue = raw.accountValue != null ? Number(raw.accountValue) : null

    return {
      trader_key: raw.ethAddress ?? raw.user ?? null,
      display_name: raw.displayName ?? null,
      avatar_url: null,
      roi,
      pnl,
      win_rate: null,        // Requires fill-level analysis (enrichment)
      max_drawdown: null,    // Requires portfolio endpoint (enrichment)
      trades_count: null,
      followers: null,
      copiers: null,
      aum: accountValue,     // accountValue is equity/AUM, NOT PnL
      sharpe_ratio: null,
      platform_rank: null,
    }
  }
}

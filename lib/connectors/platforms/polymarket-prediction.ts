/**
 * Polymarket Prediction Market Connector
 *
 * Uses Polymarket's public data API.
 * ~1000+ traders, ranked by PnL and volume.
 * ROI must be computed from position data.
 * All endpoints are public — no auth required.
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const DATA_API = 'https://data-api.polymarket.com'
const GAMMA_API = 'https://gamma-api.polymarket.com'

export class PolymarketPredictionConnector extends BaseConnector {
  readonly platform = 'polymarket' as const
  readonly marketType = 'copy' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'polymarket',
    market_types: ['copy'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['pnl', 'aum'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 1,
    rate_limit: { rpm: 60, concurrency: 5 },
    notes: [
      'Public API, no auth',
      'Prediction market — PnL and volume only, no ROI natively',
      'Max ~1050 traders via offset pagination',
      'trader_key = proxy wallet address (0x...)',
    ],
  }

  async discoverLeaderboard(window: Window, limit = 100, offset = 0): Promise<DiscoverResult> {
    const periodMap: Record<Window, string> = {
      '7d': 'WEEK',
      '30d': 'MONTH',
      '90d': 'ALL', // No 90d, use ALL as closest
    }

    // Cap at 100 to avoid DB write timeout (global default is 2000 but Polymarket
    // has complex upserts that timeout on Supabase with >200 rows)
    const effectiveLimit = Math.min(limit, 100)
    const allTraders: TraderSource[] = []
    let currentOffset = offset
    const maxOffset = 1000
    const pageSize = Math.min(effectiveLimit, 50)

    while (currentOffset <= maxOffset && allTraders.length < effectiveLimit) {
      const batchLimit = Math.min(pageSize, limit - allTraders.length)
      if (batchLimit <= 0) break

      const raw = await this.request<Record<string, unknown>[]>(
        `${DATA_API}/v1/leaderboard?timePeriod=${periodMap[window]}&orderBy=PNL&limit=${batchLimit}&offset=${currentOffset}`,
        { method: 'GET' }
      )

      if (!Array.isArray(raw) || raw.length === 0) break

      const traders: TraderSource[] = raw.map((item, i) => ({
        platform: 'polymarket' as const,
        market_type: 'copy' as const,
        trader_key: String(item.proxyWallet || ''),
        display_name: (item.userName as string) || null,
        profile_url: `https://polymarket.com/profile/${item.proxyWallet}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: { ...item, _rank: currentOffset + i + 1 },
      }))
      allTraders.push(...traders)

      if (raw.length < batchLimit) break
      currentOffset += batchLimit
      await this.sleep(200)
    }

    return {
      traders: allTraders,
      total_available: allTraders.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const raw = await this.request<Record<string, unknown>>(
        `${GAMMA_API}/public-profile?address=${traderKey}`,
        { method: 'GET' }
      )
      if (!raw) return null

      // Get portfolio value
      let aum: number | null = null
      try {
        const valueRaw = await this.request<Array<{ value: number }>>(
          `${DATA_API}/value?user=${traderKey}`,
          { method: 'GET' }
        )
        if (Array.isArray(valueRaw) && valueRaw.length > 0) {
          aum = this.num(valueRaw[0].value)
        }
      } catch (err) { this.logger.debug('Polymarket portfolio value fallback:', err instanceof Error ? err.message : String(err)) }

      const profile: TraderProfile = {
        platform: 'polymarket',
        market_type: 'copy',
        trader_key: traderKey,
        display_name: (raw.name as string) || (raw.pseudonym as string) || null,
        avatar_url: (raw.profileImage as string) || null,
        bio: (raw.bio as string) || null,
        tags: raw.verifiedBadge ? ['verified'] : [],
        profile_url: `https://polymarket.com/profile/${traderKey}`,
        followers: null,
        copiers: null,
        aum,
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: this.buildProvenance(`${GAMMA_API}/public-profile?address=${traderKey}`),
      }
      return { profile, fetched_at: new Date().toISOString() }
    } catch (err) {
      this.logger.debug('Polymarket profile fetch failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const periodMap: Record<Window, string> = {
      '7d': 'WEEK',
      '30d': 'MONTH',
      '90d': 'ALL',
    }

    // Get leaderboard entry for this user
    const raw = await this.request<Record<string, unknown>[]>(
      `${DATA_API}/v1/leaderboard?timePeriod=${periodMap[window]}&user=${traderKey}&limit=1`,
      { method: 'GET' }
    )

    const entry = Array.isArray(raw) && raw.length > 0 ? raw[0] : null

    const pnl = entry ? this.num(entry.pnl) : null
    const volume = entry ? this.num(entry.vol) : null

    // Compute rough ROI from PnL / volume (approximate)
    const roi = pnl != null && volume != null && volume > 0 ? (pnl / volume) * 100 : null

    const metrics: SnapshotMetrics = {
      roi,
      pnl,
      win_rate: null,
      max_drawdown: null,
      sharpe_ratio: null,
      sortino_ratio: null,
      trades_count: null,
      followers: null,
      copiers: null,
      aum: null,
      platform_rank: entry ? this.num(entry.rank) : null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
    }

    const quality_flags = this.buildQualityFlags(metrics, window, window !== '90d')
    if (window === '90d') {
      quality_flags.notes.push('Using ALL time period as proxy for 90d')
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    // Polymarket has no timeseries endpoint
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const pnl = this.num(raw.pnl)
    const volume = this.num(raw.vol)
    const roi = pnl != null && volume != null && volume > 0 ? (pnl / volume) * 100 : null

    return {
      trader_key: raw.proxyWallet ?? null,
      display_name: raw.userName ?? null,
      avatar_url: raw.profileImage ?? null,
      roi,
      pnl,
      win_rate: null,
      max_drawdown: null,
      sharpe_ratio: null,
      trades_count: null,
      followers: null,
      copiers: null,
      aum: null,
      platform_rank: this.num(raw.rank ?? raw._rank),
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

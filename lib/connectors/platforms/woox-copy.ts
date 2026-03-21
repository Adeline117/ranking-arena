/**
 * WOO X Copy Trading Connector
 *
 * Uses WOO X's public copy trading gateway API.
 * ~12 curated lead traders with rich data (ROI, PnL, MDD, Sharpe, WR, equity curve).
 * All endpoints are public — no auth required.
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const BASE = 'https://api.woox.io/copy-trading-gateway/public'

export class WooxCopyConnector extends BaseConnector {
  readonly platform = 'woox' as const
  readonly marketType = 'copy' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'woox',
    market_types: ['copy'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'sharpe_ratio', 'copiers', 'aum'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: ['Public API, no auth', 'Curated lead traders (~12)', '30-point ROI equity curve inline'],
  }

  async discoverLeaderboard(window: Window, _limit = 50, _offset = 0): Promise<DiscoverResult> {
    // WOO X has a single leaderboard across all periods, but metrics vary by period
    const raw = await this.request<Record<string, unknown>>(
      `${BASE}/lead-trader-dashboard/sorting-strategy-list?page=1&pageSize=50`,
      { method: 'GET' }
    )

    const rows = (raw?.data as Record<string, unknown>)?.rows as Record<string, unknown>[] || []

    const traders: TraderSource[] = rows.map((item) => ({
      platform: 'woox' as const,
      market_type: 'copy' as const,
      trader_key: String(item.strategyId || item.leadTraderId || ''),
      display_name: (item.leadTraderCoolName as string) || (item.strategyName as string) || null,
      profile_url: `https://woox.io/en/social-trading/strategy/${item.strategyId}`,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: item,
    }))

    return {
      traders,
      total_available: (raw?.data as Record<string, unknown>)?.meta
        ? this.num(((raw.data as Record<string, unknown>).meta as Record<string, unknown>).totalCount) ?? traders.length
        : traders.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // Use the listing endpoint to find the trader
    const raw = await this.request<Record<string, unknown>>(
      `${BASE}/lead-trader-dashboard/sorting-strategy-list?page=1&pageSize=50`,
      { method: 'GET' }
    )
    const rows = (raw?.data as Record<string, unknown>)?.rows as Record<string, unknown>[] || []
    const item = rows.find((r) => String(r.strategyId) === traderKey || String(r.leadTraderId) === traderKey)
    if (!item) return null

    const profile: TraderProfile = {
      platform: 'woox',
      market_type: 'copy',
      trader_key: traderKey,
      display_name: (item.leadTraderCoolName as string) || (item.strategyName as string) || null,
      avatar_url: (item.avatarUrl as string) || null,
      bio: (item.strategyIntro as string) || null,
      tags: item.strategyTraderType === 'INSTITUTION' ? ['institution'] : [],
      profile_url: `https://woox.io/en/social-trading/strategy/${traderKey}`,
      followers: null,
      copiers: this.num(item.currentNumberCu),
      aum: this.num(item.auc),
      updated_at: new Date().toISOString(),
      last_enriched_at: new Date().toISOString(),
      provenance: this.buildProvenance(`${BASE}/lead-trader-dashboard/sorting-strategy-list`),
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const periodMap: Record<Window, string> = {
      '7d': 'SEVEN_DAYS',
      '30d': 'THIRTY_DAYS',
      '90d': 'NINETY_DAYS',
    }

    const raw = await this.request<Record<string, unknown>>(
      `${BASE}/lead-strategy-profile/${traderKey}/metrics?tradePeriod=${periodMap[window]}`,
      { method: 'GET' }
    )

    const data = raw?.data as Record<string, unknown>
    if (!data) return null

    // ROI comes as decimal (e.g., 1.1726 = 117.26%)
    const rawRoi = this.num(data.roi)
    const roi = rawRoi != null ? rawRoi * 100 : null

    // Win rate as decimal
    const rawWr = this.num(data.winRate)
    const winRate = rawWr != null ? rawWr * 100 : null

    // Max drawdown as decimal
    const rawMdd = this.num(data.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd * 100) : null

    const metrics: SnapshotMetrics = {
      roi,
      pnl: this.num(data.pnl),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      sharpe_ratio: this.num(data.sharpeRatio),
      sortino_ratio: null,
      trades_count: this.num(data.numberOfTrades),
      followers: null,
      copiers: this.num(data.copierAssets) != null ? null : null, // copiers count from listing
      aum: this.num(data.copierAssets),
      platform_rank: null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
    }

    const quality_flags = this.buildQualityFlags(metrics, window, true)
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    // metricCharts is embedded in the leaderboard listing response
    const raw = await this.request<Record<string, unknown>>(
      `${BASE}/lead-trader-dashboard/sorting-strategy-list?page=1&pageSize=50`,
      { method: 'GET' }
    )
    const rows = (raw?.data as Record<string, unknown>)?.rows as Record<string, unknown>[] || []
    const item = rows.find((r) => String(r.strategyId) === traderKey || String(r.leadTraderId) === traderKey)

    if (!item?.metricCharts || !Array.isArray(item.metricCharts)) {
      return { series: [], fetched_at: new Date().toISOString() }
    }

    // metricCharts contains 30-point ROI curve but TimeseriesResult expects TraderTimeseries[]
    // For now return empty — enrichment can extract this later
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const rawRoi = this.num(raw.roi)
    const roi = rawRoi != null ? rawRoi * 100 : null // decimal → percentage

    const rawWr = this.num(raw.winRate)
    const winRate = rawWr != null ? rawWr * 100 : null

    const rawMdd = this.num(raw.mdd ?? raw.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd * 100) : null

    return {
      trader_key: raw.strategyId ?? raw.leadTraderId ?? null,
      display_name: raw.leadTraderCoolName ?? raw.strategyName ?? null,
      avatar_url: raw.avatarUrl ?? null,
      roi,
      pnl: this.num(raw.pnl),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      sharpe_ratio: this.num(raw.sharpeRatio),
      trades_count: null,
      followers: null,
      copiers: this.num(raw.currentNumberCu),
      aum: this.num(raw.auc),
      platform_rank: null,
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

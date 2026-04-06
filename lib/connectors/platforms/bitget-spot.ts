/**
 * Bitget Spot Connector
 *
 * Fetches spot copy-trading leaderboard from Bitget.
 *
 * Strategy chain:
 * 1. VPS Playwright scraper (intercepts /v1/trace/spot/public/traderRankingList)
 * 2. Direct API: www.bitget.com/v1/copy/spot/trader/list (POST, CF protected)
 * 3. Direct API: www.bitget.com/v1/trace/spot/public/traderRankingList (GET, CF protected)
 *
 * Notes:
 * - api.bitget.com spot endpoints return 404 (deprecated since ~2025)
 * - www.bitget.com endpoints are Cloudflare-protected but accessible from Vercel hnd1
 * - ROI from listing is percentage (e.g., 7583.61 = 7583.61%)
 * - Reuses Bitget Futures schemas (same response format)
 */

import { BaseConnector } from '../base'
import { safeNumber, safePercent, safeStr, safeMdd, safeInt } from '../utils'
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
  TraderProfile,
  SnapshotMetrics,
  QualityFlags,
} from '../../types/leaderboard'

/** Raw entry from Bitget Spot leaderboard API */
interface BitgetSpotEntry {
  traderId?: string
  traderUid?: string
  uid?: string
  nickName?: string
  traderName?: string
  displayName?: string
  userName?: string
  headUrl?: string
  headPic?: string
  avatar?: string
  roi?: number | string
  profitRate?: number | string
  yieldRate?: number | string
  profit?: number | string
  totalProfit?: number | string
  totalPnl?: number | string
  winRate?: number | string
  winRatio?: number | string
  maxDrawdown?: number | string
  mdd?: number | string
  drawDown?: number | string
  followerNum?: number | string
  followerCount?: number | string
  copyTraderNum?: number | string
  currentCopyCount?: number | string
  followCount?: number | string
  totalFollowAssets?: number | string
  aum?: number | string
  totalOrder?: number | string
  totalTradeCount?: number | string
  rankingNo?: number
}

const WINDOW_MAP: Record<Window, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

const WINDOW_SORT_MAP: Record<Window, number> = {
  '7d': 1,
  '30d': 2,
  '90d': 0,
}

export class BitgetSpotConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'bitget_spot'
  readonly marketType: MarketType = 'spot'

  readonly capabilities: PlatformCapabilities = {
    platform: 'bitget_spot',
    market_types: ['spot'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: [
      'CF protected — VPS scraper as primary strategy',
      'api.bitget.com spot endpoints 404, use www.bitget.com',
      'ROI in percentage format',
    ],
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 100,
    _offset: number = 0,
  ): Promise<DiscoverResult> {
    const seen = new Set<string>()
    const allTraders: TraderSource[] = []

    // Strategy 1: VPS Playwright scraper
    try {
      const vpsData = await this.fetchViaVPS<{ traders?: BitgetSpotEntry[] }>(
        `/bitget_spot/leaderboard`,
        { period: String(WINDOW_MAP[window]), pageSize: '50' },
        90000,
      )
      if (vpsData?.traders?.length) {
        for (const entry of vpsData.traders) {
          const id = this.extractId(entry)
          if (!id || seen.has(id)) continue
          seen.add(id)
          allTraders.push(this.toTraderSource(entry, id))
        }
      }
    } catch (err) {
      this.logger.debug('Bitget spot VPS scraper fallback:', err instanceof Error ? err.message : String(err))
    }

    // Strategy 2: Direct POST to /v1/copy/spot/trader/list (CF protected, works from Vercel hnd1)
    if (allTraders.length < limit) {
      const sortPeriod = WINDOW_SORT_MAP[window]
      for (let page = 1; page <= 5; page++) {
        try {
          const data = await this.request<{ code?: string; data?: { list?: BitgetSpotEntry[]; total?: number } }>(
            `https://www.bitget.com/v1/copy/spot/trader/list`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                pageNo: page,
                pageSize: 20,
                sortField: 'ROI',
                sortType: sortPeriod,
              }),
            },
          )
          const list = data?.data?.list || []
          if (!Array.isArray(list) || list.length === 0) break

          for (const entry of list) {
            const id = this.extractId(entry)
            if (!id || seen.has(id)) continue
            seen.add(id)
            allTraders.push(this.toTraderSource(entry, id))
          }

          if (list.length < 20) break
          await new Promise(r => setTimeout(r, 500))
        } catch (err) {
          this.logger.debug('Bitget spot page fetch fallback:', err instanceof Error ? err.message : String(err))
          break
        }
      }
    }

    // Strategy 3: Direct GET to /v1/trace/spot/public/traderRankingList
    if (allTraders.length < limit) {
      const dateType = WINDOW_MAP[window]
      for (let page = 1; page <= 5; page++) {
        try {
          const data = await this.request<{ code?: string; data?: { list?: BitgetSpotEntry[] } }>(
            `https://www.bitget.com/v1/trace/spot/public/traderRankingList?pageNo=${page}&pageSize=20&dateType=${dateType}`,
          )
          const list = data?.data?.list || []
          if (!Array.isArray(list) || list.length === 0) break

          for (const entry of list) {
            const id = this.extractId(entry)
            if (!id || seen.has(id)) continue
            seen.add(id)
            allTraders.push(this.toTraderSource(entry, id))
          }

          if (list.length < 20) break
          await new Promise(r => setTimeout(r, 500))
        } catch (err) {
          this.logger.debug('Bitget spot ranking list fallback:', err instanceof Error ? err.message : String(err))
          break
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

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // Try spot-specific detail endpoint
    try {
      const data = await this.request<{ code?: string; data?: BitgetSpotEntry }>(
        `https://www.bitget.com/v1/copy/spot/trader/detail?traderId=${traderKey}`,
      )
      const info = data?.data
      if (info) {
        const profile: TraderProfile = {
          platform: 'bitget_spot',
          market_type: 'spot',
          trader_key: traderKey,
          display_name: safeStr(info.nickName ?? info.traderName ?? info.displayName),
          avatar_url: safeStr(info.headUrl ?? info.headPic ?? info.avatar),
          bio: null,
          tags: [],
          profile_url: `https://www.bitget.com/copy-trading/trader/${traderKey}/spot`,
          followers: safeInt(info.followerNum ?? info.followerCount ?? info.followCount),
          copiers: safeInt(info.copyTraderNum ?? info.currentCopyCount),
          aum: safeNumber(info.totalFollowAssets ?? info.aum),
          updated_at: new Date().toISOString(),
          last_enriched_at: new Date().toISOString(),
          provenance: {
            source_platform: 'bitget_spot',
            acquisition_method: 'api',
            fetched_at: new Date().toISOString(),
            source_url: `https://www.bitget.com/v1/copy/spot/trader/detail?traderId=${traderKey}`,
            scraper_version: '1.0.0',
          },
        }
        return { profile, fetched_at: new Date().toISOString() }
      }
    } catch (err) {
      this.logger.debug('Bitget spot profile fetch failed:', err instanceof Error ? err.message : String(err))
    }

    return null
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    // Try spot detail with time range
    try {
      const dateType = WINDOW_MAP[window]
      const data = await this.request<{ code?: string; data?: BitgetSpotEntry }>(
        `https://www.bitget.com/v1/copy/spot/trader/detail?traderId=${traderKey}&dateType=${dateType}`,
      )
      const info = data?.data
      if (info) {
        const metrics: SnapshotMetrics = {
          roi: safePercent(info.roi ?? info.profitRate ?? info.yieldRate),
          pnl: safeNumber(info.profit ?? info.totalProfit ?? info.totalPnl),
          win_rate: this.normalizeWinRate(info.winRate ?? info.winRatio),
          max_drawdown: safeMdd(info.maxDrawdown ?? info.mdd ?? info.drawDown),
          sharpe_ratio: null,
          sortino_ratio: null,
          trades_count: safeInt(info.totalOrder ?? info.totalTradeCount),
          followers: safeInt(info.followerNum ?? info.followerCount ?? info.followCount),
          copiers: safeInt(info.copyTraderNum ?? info.currentCopyCount),
          aum: safeNumber(info.totalFollowAssets ?? info.aum),
          platform_rank: null,
          arena_score: null,
          return_score: null,
          drawdown_score: null,
          stability_score: null,
        }

        const quality_flags: QualityFlags = {
          missing_fields: ['sharpe_ratio', 'sortino_ratio'],
          non_standard_fields: {},
          window_native: true,
          notes: [],
        }

        return { metrics, quality_flags, fetched_at: new Date().toISOString() }
      }
    } catch (err) {
      this.logger.debug('Bitget spot snapshot fetch failed:', err instanceof Error ? err.message : String(err))
    }

    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    // Bitget Spot does not provide timeseries data via public API
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw Bitget Spot leaderboard entry.
   * Outputs the standard 13 fields for the Connector framework.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // ROI: Bitget spot API returns percentage values directly
    // Small absolute values (< 10) are likely ratios and need ×100
    let roi = safeNumber(raw.roi ?? raw.profitRate ?? raw.yieldRate)
    if (roi !== null && Math.abs(roi) > 0 && Math.abs(roi) < 10) {
      roi = roi * 100
    }

    return {
      trader_key: safeStr(raw.traderId ?? raw.traderUid ?? raw.uid),
      display_name: safeStr(raw.nickName ?? raw.traderName ?? raw.displayName ?? raw.userName),
      avatar_url: safeStr(raw.headUrl ?? raw.headPic ?? raw.avatar),
      roi,
      pnl: safeNumber(raw.profit ?? raw.totalProfit ?? raw.totalPnl),
      win_rate: this.normalizeWinRate(raw.winRate ?? raw.winRatio),
      max_drawdown: safeMdd(raw.maxDrawdown ?? raw.mdd ?? raw.drawDown),
      trades_count: safeInt(raw.totalOrder ?? raw.totalTradeCount),
      followers: safeInt(raw.followerNum ?? raw.followerCount ?? raw.followCount ?? raw.copyTraderNum ?? raw.currentCopyCount),
      copiers: safeInt(raw.copyTraderNum ?? raw.currentCopyCount),
      aum: safeNumber(raw.totalFollowAssets ?? raw.aum),
      sharpe_ratio: null,
      platform_rank: safeInt(raw.rankingNo),
    }
  }

  // ============================================
  // Private helpers
  // ============================================

  private extractId(entry: BitgetSpotEntry): string | null {
    const id = entry.traderId || entry.traderUid || (entry.uid ? String(entry.uid) : null)
    return id || null
  }

  private toTraderSource(entry: BitgetSpotEntry, id: string): TraderSource {
    return {
      platform: 'bitget_spot',
      market_type: 'spot',
      trader_key: id,
      display_name: safeStr(entry.nickName ?? entry.traderName ?? entry.displayName ?? entry.userName),
      profile_url: `https://www.bitget.com/copy-trading/trader/${id}/spot`,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: entry as Record<string, unknown>,
    }
  }

  /** Normalize win rate: values <= 1 are ratios, multiply by 100. Clamp to 0-100%. */
  private normalizeWinRate(val: unknown): number | null {
    const n = safeNumber(val)
    if (n === null) return null
    const pct = (n > 0 && n <= 1) ? n * 100 : n
    // Clamp to valid range 0-100%
    if (pct < 0 || pct > 100) return null
    return pct
  }
}

/**
 * BingX Futures Connector
 *
 * Uses BingX's internal API for copy trading leaderboard data.
 * Similar to Binance's bapi pattern.
 *
 * Key notes:
 * - trader_key is BingX UID
 * - Has copy trading features (followers, copiers, ROI)
 * - CloudFlare protected - may need realistic headers
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  BingxFuturesLeaderboardResponseSchema,
  BingxFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface BingXLeaderboardEntry {
  uniqueId?: string
  traderName?: string
  headUrl?: string
  roi?: number
  pnl?: number
  followerNum?: number
  copyNum?: number
  winRate?: number
  maxDrawdown?: number
  aum?: number
}

export class BingxFuturesConnector extends BaseConnector {
  readonly platform = 'bingx' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'bingx',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['CloudFlare protected', 'Copy trading platform', 'Uses internal bapi-style endpoints'],
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://bingx.com',
      'Referer': 'https://bingx.com/en/CopyTrading/leaderBoard',
    }
  }

  async discoverLeaderboard(window: Window, limit = 2000, _offset = 0): Promise<DiscoverResult> {
    // Map window to BingX period format
    const periodMap: Record<Window, string> = {
      '7d': '7',
      '30d': '30',
      '90d': '90',
    }
    const period = periodMap[window] || '30'

    try {
      // Try VPS Playwright scraper first (BingX has WAF, proxy forwarding won't work)
      let _rawLb = await this.fetchViaVPS<{ data?: { list?: BingXLeaderboardEntry[] } }>('/bingx/leaderboard', {
        period,
        pageSize: String(limit),
      }, 120000);

      // Fallback to direct BingX API if VPS failed
      if (!_rawLb) {
        const directUrl = `https://bingx.com/api/uc/v1/public/copyTrade/traders?page=1&pageSize=${limit}&period=${period}&sortBy=roi&sortOrder=desc`
        _rawLb = await this.request<{ data?: { list?: BingXLeaderboardEntry[] } }>(
          directUrl,
          { method: 'GET', headers: this.getHeaders() }
        );
      }

      // Parse directly from raw — Zod defaults data.list=[] hiding scraper's data.global.result
      const dataObj = (_rawLb?.data ?? {}) as Record<string, unknown>
      const globalObj = dataObj?.global as Record<string, unknown> | undefined
      const rawList = dataObj?.list || globalObj?.result || []
      const list = Array.isArray(rawList) ? rawList : []
      const traders: TraderSource[] = list.map((item: Record<string, unknown>) => {
        // BingX scraper returns nested: { traderInfoVo: { trader, traderName, ... }, ... }
        // Direct API returns flat: { uniqueId, traderName, ... }
        const info = item.traderInfoVo as Record<string, unknown> | undefined
        const traderId = String(info?.trader || info?.apiIdentity || item.uniqueId || item.traderUid || item.uid || '')
        const traderName = String(info?.traderName || item.traderName || '') || null
        return {
          platform: 'bingx' as const,
          market_type: 'futures' as const,
          trader_key: traderId,
          display_name: traderName,
          profile_url: `https://bingx.com/en/CopyTrading/tradeDetail/${traderId}`,
          discovered_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          is_active: true,
          raw: item as Record<string, unknown>,
        }
      })

      return { traders, total_available: traders.length, window, fetched_at: new Date().toISOString() }
    } catch (err) {
      console.error(`[bingx] discoverLeaderboard error: ${err instanceof Error ? err.message : String(err)}`)
      // Return empty result if API fails (may need Puppeteer scraping)
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const _rawProfile = await this.request<{ data?: BingXLeaderboardEntry }>(
        `https://bingx.com/api/uc/v1/public/copyTrade/trader/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(BingxFuturesDetailResponseSchema, _rawProfile, 'bingx-futures/profile')

      const info = data?.data
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'bingx',
        market_type: 'futures',
        trader_key: traderKey,
        display_name: info.traderName || null,
        avatar_url: info.headUrl || null,
        bio: null,
        tags: ['copy-trading', 'futures'],
        profile_url: `https://bingx.com/en/CopyTrading/tradeDetail/${traderKey}`,
        followers: this.num(info.followerNum),
        copiers: this.num(info.copyNum),
        aum: this.num(info.aum),
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'bingx',
          acquisition_method: 'api',
          fetched_at: new Date().toISOString(),
          source_url: null,
          scraper_version: '1.0.0',
        },
      }
      return { profile, fetched_at: new Date().toISOString() }
    } catch (err) {
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' }
    const period = periodMap[window] || '30'

    try {
      const _rawSnap = await this.request<{ data?: BingXLeaderboardEntry }>(
        `https://bingx.com/api/uc/v1/public/copyTrade/trader/${traderKey}?period=${period}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(BingxFuturesDetailResponseSchema, _rawSnap, 'bingx-futures/snapshot')

      const info = data?.data
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: true, notes: ['Trader not found'] },
          fetched_at: new Date().toISOString(),
        }
      }

      const metrics: SnapshotMetrics = {
        roi: this.num(info.roi),
        pnl: this.num(info.pnl),
        win_rate: this.num(info.winRate),
        max_drawdown: this.num(info.maxDrawdown),
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: null,
        followers: this.num(info.followerNum),
        copiers: this.num(info.copyNum),
        aum: this.num(info.aum),
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const quality_flags: QualityFlags = {
        missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count'],
        non_standard_fields: {},
        window_native: true,
        notes: ['BingX copy trading platform'],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch (err) {
      return null
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    // BingX doesn't provide public timeseries API
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw BingX leaderboard entry.
   * Raw fields: uniqueId/uid/traderId, traderName/nickname/nickName,
   * roi/roiRate/returnRate/pnlRatio (decimal), pnl/totalPnl/totalEarnings,
   * winRate (decimal), maxDrawdown (decimal), followerNum/followers.
   * Note: ROI in decimal format, normalized via ×100 if ≤1.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // Handle nested scraper format: { traderInfoVo: { trader, traderName }, cumulativePnlRate7Days, ... }
    const info = raw.traderInfoVo as Record<string, unknown> | undefined

    const rawRoi = this.num(raw.roi ?? raw.roiRate ?? raw.returnRate ?? raw.pnlRatio ?? raw.cumulativePnlRate7Days)
    const roi = rawRoi != null ? (Math.abs(rawRoi) <= 1 ? rawRoi * 100 : rawRoi) : null
    const rawWr = this.num(raw.winRate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
    const rawMdd = this.num(raw.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    return {
      trader_key: info?.trader ?? info?.apiIdentity ?? raw.uniqueId ?? raw.uid ?? raw.traderId ?? null,
      display_name: info?.traderName ?? raw.traderName ?? raw.nickname ?? raw.nickName ?? raw.displayName ?? null,
      avatar_url: info?.avatar ?? raw.headUrl ?? raw.avatarUrl ?? raw.avatar ?? null,
      roi,
      pnl: this.num(raw.pnl ?? raw.totalPnl ?? raw.totalEarnings ?? raw.followerEarning ?? raw.profit),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: null,
      followers: this.num(raw.followerNum ?? raw.followers ?? raw.followerCount),
      copiers: null,
      aum: null,
      sharpe_ratio: null,
      platform_rank: this.num(raw.rank),
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}

/**
 * XT.com Futures Connector
 *
 * Uses XT.com's internal endpoints for copy trading leaderboard data.
 * Note: XT.com does NOT have a public leaderboard API - this connector
 * attempts to use internal endpoints and may require Puppeteer scraping.
 *
 * Key notes:
 * - trader_key is XT.com UID
 * - Has both spot and futures copy trading
 * - May require web scraping for full functionality
 */

import { BaseConnector } from '../base'
import { safeNumber, safePercent, safeNonNeg, safeStr, safeMdd } from '../utils'
import { warnValidate } from '../schemas'
import {
  XtFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('connector:xt')

interface XTLeaderboardEntry {
  uid?: string
  accountId?: string
  leaderUid?: string
  nickname?: string
  avatar?: string
  roi?: number
  pnl?: number
  followerCount?: number
  copyCount?: number
  winRate?: number
  maxDrawdown?: number
  aum?: number
}

export class XtFuturesConnector extends BaseConnector {
  readonly platform = 'xt' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'xt',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 4, // Requires web scraping
    rate_limit: { rpm: 15, concurrency: 2 },
    notes: ['No public API', 'Requires Puppeteer scraping', 'Copy trading platform'],
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.xt.com',
      'Referer': 'https://www.xt.com/en/copy-trading/futures',
    }
  }

  async discoverLeaderboard(window: Window, limit = 2000, _offset = 0): Promise<DiscoverResult> {
    // XT.com API (/sapi/v1/copy-trading) returns 404 since ~2026-03.
    // Real API is /fapi/user/v1/public/copy-trade/elite-leader-list-v2 (Cloudflare-protected).
    // Strategy 1: VPS Playwright scraper (page.evaluate fetches the API with browser context)
    const allTraders: TraderSource[] = []

    try {
      const vpsData = await this.fetchViaVPS<{ traders?: Array<{ sotType?: string; items?: XTLeaderboardEntry[] }> }>(
        '/xt/leaderboard',
        { pageSize: String(limit) },
        120000
      )
      if (!vpsData) {
        log.warn('VPS scraper returned null — scraper may be busy or unreachable')
      }
      // Scraper returns: { returnCode: 0, result: [{ sotType: "INCOME_RATE", items: [...] }] }
      // or legacy: { traders: [...] }
      const vpsAny = vpsData as Record<string, unknown>
      const groups = (vpsAny?.result || vpsAny?.traders || []) as Array<{ sotType?: string; items?: XTLeaderboardEntry[] }>
      const seen = new Set<string>()
      if (Array.isArray(groups)) {
        for (const group of groups) {
          const items = group?.items || []
          for (const item of items) {
            const uid = String(item.accountId || item.uid || item.leaderUid || '')
            if (!uid || seen.has(uid)) continue
            seen.add(uid)
            allTraders.push({
              platform: 'xt',
              market_type: 'futures' as const,
              trader_key: uid,
              display_name: (item as Record<string, unknown>).nickName as string || item.nickname || null,
              profile_url: `https://www.xt.com/en/copy-trading/trader/${uid}`,
              discovered_at: new Date().toISOString(),
              last_seen_at: new Date().toISOString(),
              is_active: true,
              raw: item as Record<string, unknown>,
            })
          }
        }
      }
    } catch (err) {
      log.warn(`VPS scraper error: ${err instanceof Error ? err.message : String(err)}`)
    }

    return { traders: allTraders.slice(0, limit), total_available: allTraders.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const _rawProfile = await this.request<{ data?: XTLeaderboardEntry }>(
        `https://www.xt.com/sapi/v1/copy-trading/leader/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(XtFuturesDetailResponseSchema, _rawProfile, 'xt-futures/profile')

      const info = data?.data
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'xt',
        market_type: 'futures',
        trader_key: traderKey,
        display_name: info.nickname || null,
        avatar_url: info.avatar || null,
        bio: null,
        tags: ['copy-trading', 'futures'],
        profile_url: `https://www.xt.com/en/copy-trading/trader/${traderKey}`,
        followers: this.num(info.followerCount),
        copiers: this.num(info.copyCount),
        aum: this.num(info.aum),
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'xt',
          acquisition_method: 'api',
          fetched_at: new Date().toISOString(),
          source_url: null,
          scraper_version: '1.0.0',
        },
      }
      return { profile, fetched_at: new Date().toISOString() }
    } catch (err) {
      this.logger.debug('XT profile fetch failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' }
    const period = periodMap[window] || '30'

    try {
      const _rawSnap = await this.request<{ data?: XTLeaderboardEntry }>(
        `https://www.xt.com/sapi/v1/copy-trading/leader/${traderKey}?period=${period}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(XtFuturesDetailResponseSchema, _rawSnap, 'xt-futures/snapshot')

      const info = data?.data
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: true, notes: ['Trader not found or API blocked'] },
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
        followers: this.num(info.followerCount),
        copiers: this.num(info.copyCount),
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
        notes: ['XT.com copy trading platform'],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch (err) {
      this.logger.debug('XT snapshot fetch failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw XT.COM leaderboard entry.
   *
   * XT API returns incomeRate as RATIO (1.0852 = 108.52%), always ×100.
   * winRate and maxRetraction are also ratios (0-1 scale).
   * Verified against inline fetcher: xt.ts uses `incomeRate * 100` unconditionally.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // incomeRate is ALWAYS a ratio: 1.0852 = 108.52%, 0.05 = 5%
    const roi = safePercent(raw.incomeRate ?? raw.roi, { isRatio: true })
    // winRate is a ratio (0-1)
    const winRate = safePercent(raw.winRate, { isRatio: true })
    // maxRetraction is a ratio (0-1), always positive
    const maxDrawdown = safeMdd(raw.maxRetraction ?? raw.maxDrawdown, true)

    return {
      trader_key: safeStr(raw.accountId ?? raw.uid),
      display_name: safeStr(raw.nickName ?? raw.nickname),
      avatar_url: safeStr(raw.avatar ?? raw.avatarUrl ?? raw.headUrl ?? raw.headPic),
      roi,
      pnl: safeNumber(raw.income ?? raw.pnl),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: null,
      followers: safeNonNeg(raw.followerCount),
      copiers: null,
      aum: safeNonNeg(raw.totalFollowerMargin),
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

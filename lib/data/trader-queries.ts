/**
 * Trader query functions — database queries for trader detail pages.
 * Re-exported through lib/data/trader.ts as the public API.
 *
 * These query trader_snapshots_v2, leaderboard_ranks, and related tables.
 */

import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import * as cache from '@/lib/cache'
import { CacheKey, CACHE_TTL } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'
import type {
  TraderProfile,
  TraderPerformance,
  TraderStats,
  PortfolioItem,
  PositionHistoryItem,
  TraderFeedItem,
} from './trader-types'
import { findTraderAcrossSources, getTraderArenaFollowersCountBatch } from './trader-utils'
import { type DataResult, success, failure } from '@/lib/types/result'

// ============================================
// Public API functions
// ============================================

/**
 * 根据 handle 获取交易员基本信息
 */
export async function getTraderByHandle(handle: string): Promise<DataResult<TraderProfile | null>> {
  if (!handle) return success(null)

  const cacheKey = CacheKey.traders.detail(handle)

  return cache.getOrSet(
    cacheKey,
    async (): Promise<DataResult<TraderProfile | null>> => {
      try {
        const source = await findTraderAcrossSources(handle)

        if (!source) {
          return success(null)
        }

        const [followersCount, profileData] = await Promise.all([
          (async () => {
            const { getTraderArenaFollowersCount } = await import('./trader-followers')
            return getTraderArenaFollowersCount(supabase, source.source_trader_id)
          })(),
          (async () => {
            const profileHandle = source.handle || source.source_trader_id
            const decodedHandle = decodeURIComponent(handle)

            const { data } = await supabase
              .from('user_profiles')
              .select('id, bio, avatar_url, cover_url')
              .or(
                `handle.eq.${profileHandle.replace(/[,.()\[\]\\%_]/g, '')},handle.eq.${decodedHandle.replace(/[,.()\[\]\\%_]/g, '')},handle.eq.${handle.replace(/[,.()\[\]\\%_]/g, '')}`
              )
              .limit(1)
              .maybeSingle()

            return data
          })(),
        ])

        return success({
          handle: source.handle || source.source_trader_id,
          id: source.source_trader_id,
          bio: profileData?.bio || undefined,
          followers: followersCount,
          copiers: 0,
          avatar_url: profileData?.avatar_url || source.profile_url || undefined,
          cover_url: profileData?.cover_url || undefined,
          isRegistered: !!profileData,
          source: source.source,
        })
      } catch (error) {
        const logger = createLogger('trader-data')
        logger.error('Error in getTraderByHandle', { error, handle })
        return failure(
          error instanceof Error ? error.message : 'Unknown error in getTraderByHandle'
        )
      }
    },
    { ttl: CACHE_TTL.TRADER_DETAIL }
  )
}

/**
 * 获取交易员绩效数据
 */
export async function getTraderPerformance(
  handle: string,
  period: '7D' | '30D' | '90D' | '1Y' | '2Y' | 'All' = '90D'
): Promise<DataResult<TraderPerformance>> {
  const cacheKey = CacheKey.traders.performance(handle, period)

  return cache.getOrSet(
    cacheKey,
    async (): Promise<DataResult<TraderPerformance>> => {
      try {
        const source = await findTraderAcrossSources(handle)

        if (!source) {
          return success({ roi_90d: 0 })
        }

        // Migrated off retiring trader_latest → leaderboard_ranks (per-season,
        // source/season_id; roi/pnl aliased from roi_pct/pnl_usd).
        const { data: allSnapshots } = await supabase
          .from('leaderboard_ranks')
          .select('season_id, roi, pnl, win_rate, max_drawdown')
          .eq('source', source.source)
          .eq('source_trader_id', source.source_trader_id)
          .in('season_id', ['7D', '30D', '90D'])

        // Map by season (leaderboard_ranks has 1 row per season)
        const byWindow = new Map<
          string,
          typeof allSnapshots extends (infer T)[] | null ? T : never
        >()
        for (const s of allSnapshots || []) {
          if (!byWindow.has(s.season_id)) byWindow.set(s.season_id, s)
        }
        const data90d = byWindow.get('90D') || null
        const data7d = byWindow.get('7D') || null
        const data30d = byWindow.get('30D') || null

        return success({
          roi_90d: data90d?.roi ?? 0,
          roi_7d: data7d?.roi ?? undefined,
          roi_30d: data30d?.roi ?? undefined,
          pnl: data90d?.pnl ?? undefined,
          win_rate: data90d?.win_rate ?? undefined,
          max_drawdown: data90d?.max_drawdown ?? undefined,
          pnl_7d: data7d?.pnl ?? undefined,
          pnl_30d: data30d?.pnl ?? undefined,
          win_rate_7d: data7d?.win_rate ?? undefined,
          win_rate_30d: data30d?.win_rate ?? undefined,
          max_drawdown_7d: data7d?.max_drawdown ?? undefined,
          max_drawdown_30d: data30d?.max_drawdown ?? undefined,
          roi_1y: undefined,
          roi_2y: undefined,
        })
      } catch (error) {
        const logger = createLogger('trader-data')
        logger.error('Error in getTraderPerformance', { error, handle })
        return failure(
          error instanceof Error ? error.message : 'Unknown error in getTraderPerformance'
        )
      }
    },
    { ttl: CACHE_TTL.TRADER_PERFORMANCE }
  )
}

/**
 * 获取交易员统计数据 (cached)
 */
export async function getTraderStats(handle: string): Promise<DataResult<TraderStats>> {
  const cacheKey = CacheKey.traders.detail(handle) + ':stats'

  return cache.getOrSet(
    cacheKey,
    async (): Promise<DataResult<TraderStats>> => {
      try {
        const source = await findTraderAcrossSources(handle)

        if (!source) {
          return success({ additionalStats: {} })
        }

        // Phase 1: latest 90D + daily history in parallel. Migrated off retiring
        // trader_latest / trader_snapshots_v2 → leaderboard_ranks (latest) +
        // trader_daily_snapshots (history). (monthly/yearly tables long dropped.)
        const [latestSnapshotResult, historySnapshotsResult] = await Promise.all([
          supabase
            .from('leaderboard_ranks')
            .select('roi, computed_at, pnl, win_rate, max_drawdown, trades_count')
            .eq('source', source.source)
            .eq('source_trader_id', source.source_trader_id)
            .eq('season_id', '90D')
            .maybeSingle(),
          supabase
            .from('trader_daily_snapshots')
            .select('roi, date')
            .eq('platform', source.source)
            .eq('trader_key', source.source_trader_id)
            .order('date', { ascending: false })
            .limit(200),
        ])

        const latestSnapshot = latestSnapshotResult.data
        const snapshots = historySnapshotsResult.data || []

        if (!latestSnapshot && snapshots.length === 0) {
          return success({ additionalStats: {} })
        }

        // Frequently-traded: latest captured batch. Decoupled from trader_latest —
        // fetch recent rows and keep the most recent captured_at group.
        let frequentlyTradedData: Array<{
          symbol: string
          weight_pct: number | null
          trade_count: number | null
          avg_profit: number | null
          avg_loss: number | null
          profitable_pct: number | null
        }> = []
        {
          const { data: ftRows } = await supabase
            .from('trader_frequently_traded')
            .select(
              'symbol, weight_pct, trade_count, avg_profit, avg_loss, profitable_pct, captured_at'
            )
            .eq('source', source.source)
            .eq('source_trader_id', source.source_trader_id)
            .order('captured_at', { ascending: false })
            .limit(60)
          if (ftRows && ftRows.length > 0) {
            const latestCapture = ftRows[0].captured_at
            frequentlyTradedData = ftRows
              .filter((r) => r.captured_at === latestCapture)
              .sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0))
              .slice(0, 10)
          }
        }

        let activeSince: string | undefined = undefined
        let profitableWeeksPct: number | undefined = undefined
        if (snapshots.length > 0) {
          const earliest = snapshots[snapshots.length - 1]
          const d = new Date(earliest.date)
          activeSince = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear().toString().slice(-2)}`
          if (snapshots.length > 1) {
            const profitableWeeks = snapshots.filter((s) => (s.roi ?? 0) > 0).length
            profitableWeeksPct = (profitableWeeks / snapshots.length) * 100
          }
        }

        const frequentlyTraded = frequentlyTradedData.map((item) => ({
          symbol: item.symbol,
          weightPct: item.weight_pct ?? 0,
          count: item.trade_count ?? 0,
          avgProfit: item.avg_profit ?? 0,
          avgLoss: item.avg_loss ?? 0,
          profitablePct: item.profitable_pct ?? 0,
        }))

        return success({
          expectedDividends: undefined,
          trading: latestSnapshot
            ? {
                totalTrades12M:
                  ((latestSnapshot as Record<string, unknown>).trades_count as number) ?? 0,
                avgProfit: 0,
                avgLoss: 0,
                profitableTradesPct:
                  ((latestSnapshot as Record<string, unknown>).win_rate as number) ?? 0,
              }
            : undefined,
          frequentlyTraded: frequentlyTraded.length > 0 ? frequentlyTraded : undefined,
          additionalStats: {
            tradesPerWeek: undefined,
            avgHoldingTime: undefined,
            activeSince,
            profitableWeeksPct,
            riskScore: undefined,
            volume90d: undefined,
            maxDrawdown: latestSnapshot?.max_drawdown ?? undefined,
            sharpeRatio: undefined,
          },
          // Source tables (trader_monthly/yearly_performance) were dropped —
          // these stay undefined and the UI hides the sections.
          monthlyPerformance: undefined,
          yearlyPerformance: undefined,
        })
      } catch (error) {
        const logger = createLogger('trader-data')
        logger.error('Error in getTraderStats', { error, handle })
        return failure(error instanceof Error ? error.message : 'Unknown error in getTraderStats')
      }
    },
    { ttl: CACHE_TTL.TRADER_PERFORMANCE }
  )
}

/**
 * 获取交易员频繁交易资产
 */
export async function getTraderFrequentlyTraded(handle: string): Promise<
  DataResult<
    Array<{
      symbol: string
      weightPct: number
      count: number
      avgProfit: number
      avgLoss: number
      profitablePct: number
    }>
  >
> {
  try {
    const source = await findTraderAcrossSources(handle)
    if (!source) return success([])

    // Latest captured batch. Decoupled from retiring trader_latest — fetch recent
    // rows and keep the most recent captured_at group (was joined on
    // trader_latest.updated_at == captured_at).
    const { data: ftRows } = await supabase
      .from('trader_frequently_traded')
      .select('symbol, weight_pct, trade_count, avg_profit, avg_loss, profitable_pct, captured_at')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .order('captured_at', { ascending: false })
      .limit(60)

    if (!ftRows || ftRows.length === 0) return success([])

    const latestCapture = ftRows[0].captured_at
    const data = ftRows
      .filter((r) => r.captured_at === latestCapture)
      .sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0))
      .slice(0, 10)

    return success(
      data.map((item) => ({
        symbol: item.symbol,
        weightPct: item.weight_pct ?? 0,
        count: item.trade_count ?? 0,
        avgProfit: item.avg_profit ?? 0,
        avgLoss: item.avg_loss ?? 0,
        profitablePct: item.profitable_pct ?? 0,
      }))
    )
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderFrequentlyTraded', { error, handle })
    return failure(
      error instanceof Error ? error.message : 'Unknown error in getTraderFrequentlyTraded'
    )
  }
}

// getTraderMonthlyPerformance / getTraderYearlyPerformance were removed:
// their source tables (trader_monthly_performance, trader_yearly_performance)
// were dropped from prod and the functions had no callers (re-export only).

/**
 * 获取交易员投资组合
 */
export async function getTraderPortfolio(handle: string): Promise<DataResult<PortfolioItem[]>> {
  try {
    const source = await findTraderAcrossSources(handle)
    if (!source) return success([])

    const { data } = await supabase
      .from('trader_portfolio')
      .select('symbol, direction, weight_pct:invested_pct, entry_price') // trader_portfolio 无 pnl_pct(仅绝对 pnl)
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .order('captured_at', { ascending: false }) // trader_portfolio 无 updated_at 列(用 captured_at)
      .limit(100)

    if (!data) return success([])

    return success(
      data.map(
        (item: {
          symbol: string | null
          direction: string | null
          weight_pct: number | null
          entry_price: number | null
        }) => ({
          market: item.symbol || '',
          direction:
            item.direction === 'long' || item.direction === 'short' ? item.direction : 'long',
          invested: item.weight_pct ?? 0,
          pnl: 0, // trader_portfolio has no pnl_pct column (not in the select)
          value: item.weight_pct ?? 0,
          price: item.entry_price ?? 0,
          priceChange: undefined,
        })
      )
    )
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderPortfolio', { error, handle })
    return failure(error instanceof Error ? error.message : 'Unknown error in getTraderPortfolio')
  }
}

/**
 * 获取交易员历史订单
 */
export async function getTraderPositionHistory(
  handle: string
): Promise<DataResult<PositionHistoryItem[]>> {
  try {
    const source = await findTraderAcrossSources(handle, { includeWeb3: false })
    if (!source) return success([])

    const { data } = await supabase
      .from('trader_position_history')
      .select('symbol, direction, entry_price, exit_price, pnl_pct, open_time, close_time')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .gte('open_time', new Date(Date.now() - 90 * 86400000).toISOString())
      .order('open_time', { ascending: false })
      .limit(50)

    if (!data) return success([])

    return success(
      data.map(
        (item: {
          symbol: string | null
          direction: string | null
          entry_price: number | null
          exit_price: number | null
          pnl_pct: number | null
          open_time: string | null
          close_time: string | null
        }) => ({
          symbol: item.symbol || '',
          direction: item.direction === 'short' ? 'short' : 'long',
          entryPrice: item.entry_price || 0,
          exitPrice: item.exit_price || 0,
          pnlPct: item.pnl_pct || 0,
          openTime: item.open_time || '',
          closeTime: item.close_time || '',
        })
      )
    )
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error in getTraderPositionHistory', { error, handle })
    return failure(
      error instanceof Error ? error.message : 'Unknown error in getTraderPositionHistory'
    )
  }
}

/**
 * 获取交易员动态 feed
 */
export async function getTraderFeed(handle: string): Promise<TraderFeedItem[]> {
  try {
    const decodedHandle = decodeURIComponent(handle)

    // Launch posts, user profile, and reposts queries in parallel
    // We need the user profile ID for reposts, so we launch profile + posts together,
    // then immediately chain the reposts query off the profile result
    const postsPromise = supabase
      .from('posts')
      .select('id, title, content, created_at, group_id, like_count, is_pinned, groups(name)')
      .or(
        `author_handle.eq.${handle.replace(/[,.()\[\]\\%_]/g, '')},author_handle.eq.${decodedHandle.replace(/[,.()\[\]\\%_]/g, '')}`
      )
      .order('created_at', { ascending: false })
      .limit(20)

    const repostsPromise = supabase
      .from('user_profiles')
      .select('id')
      .or(
        `handle.eq.${handle.replace(/[,.()\[\]\\%_]/g, '')},handle.eq.${decodedHandle.replace(/[,.()\[\]\\%_]/g, '')}`
      )
      .limit(1)
      .maybeSingle()
      .then(async (userProfileResult) => {
        const userProfile = userProfileResult.data
        if (!userProfile?.id) return [] as unknown[]
        const { data } = await supabase
          .from('reposts')
          .select(
            `
            id,
            comment,
            created_at,
            post_id,
            posts (
              id,
              title,
              content,
              author_handle,
              group_id,
              like_count,
              groups (name)
            )
          `
          )
          .eq('user_id', userProfile.id)
          .order('created_at', { ascending: false })
          .limit(20)
        return (data || []) as unknown[]
      })

    const [postsResult, repostsData] = await Promise.all([postsPromise, repostsPromise])
    const posts = postsResult.data || []

    const feedItems: TraderFeedItem[] = posts.map((post) => {
      const p = post as Record<string, unknown>
      const groups = p.groups as Array<{ name: string }> | null
      return {
        id: String(p.id),
        type: p.group_id ? ('group_post' as const) : ('post' as const),
        title: String(p.title || ''),
        content: String(p.content || ''),
        time: String(p.created_at),
        groupId: p.group_id ? String(p.group_id) : undefined,
        groupName: groups?.[0]?.name,
        like_count: Number(p.like_count) || 0,
        is_pinned: Boolean(p.is_pinned),
      }
    })

    repostsData.forEach((repost) => {
      const r = repost as Record<string, unknown>
      const postData = r.posts as Record<string, unknown> | null

      if (postData) {
        const groups = postData.groups as { name: string } | null
        feedItems.push({
          id: `repost-${r.id}`,
          type: 'repost',
          title: String(postData.title || ''),
          content: String(postData.content || ''),
          time: String(r.created_at),
          groupId: postData.group_id ? String(postData.group_id) : undefined,
          groupName: groups?.name,
          like_count: Number(postData.like_count) || 0,
          is_pinned: false,
          repost_comment: r.comment ? String(r.comment) : undefined,
          original_author_handle: String(postData.author_handle || ''),
          original_post_id: String(postData.id),
        })
      }
    })

    feedItems.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())

    return feedItems
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error fetching trader feed', { error, handle })
    return []
  }
}

/**
 * 获取相似交易员
 */
export async function getSimilarTraders(
  handle: string,
  limit: number = 6
): Promise<TraderProfile[]> {
  try {
    const source = await findTraderAcrossSources(handle)
    if (!source) return []

    // Get current trader's ROI from leaderboard_ranks
    const { data: currentLR } = await supabase
      .from('leaderboard_ranks')
      .select('roi, source_trader_id')
      .eq('source', source.source)
      .eq('source_trader_id', source.source_trader_id)
      .eq('season_id', '90D')
      .limit(1)
      .maybeSingle()

    if (!currentLR) return []

    const currentRoi = currentLR.roi ?? 0
    const roiRange = Math.max(Math.abs(currentRoi) * 0.3, 20)
    const minRoi = currentRoi - roiRange
    const maxRoi = currentRoi + roiRange

    // Find similar traders by ROI range from leaderboard_ranks
    let { data: similarRows } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, roi, handle, avatar_url')
      .eq('source', source.source)
      .eq('season_id', '90D')
      .neq('source_trader_id', source.source_trader_id)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .gte('roi', minRoi)
      .lte('roi', maxRoi)
      .limit(50)

    if (!similarRows || similarRows.length === 0) {
      const { data: fallback } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, roi, handle, avatar_url')
        .eq('source', source.source)
        .eq('season_id', '90D')
        .neq('source_trader_id', source.source_trader_id)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .order('roi', { ascending: false })
        .limit(limit)

      similarRows = fallback
    }

    if (!similarRows || similarRows.length === 0) return []

    const sortedRows = similarRows
      .map((s) => ({ ...s, diff: Math.abs((s.roi || 0) - currentRoi) }))
      .sort((a, b) => a.diff - b.diff)
      .slice(0, limit)

    const traderIds = sortedRows.map((s) => s.source_trader_id)
    const followersMap = await getTraderArenaFollowersCountBatch(supabase, traderIds)

    return sortedRows.map((s) => ({
      handle: s.handle || s.source_trader_id,
      id: s.source_trader_id,
      followers: followersMap.get(s.source_trader_id) || 0,
      avatar_url: s.avatar_url || undefined,
      source: source.source,
    }))
  } catch (error) {
    const logger = createLogger('trader-data')
    logger.error('Error fetching similar traders', { error, handle })
    return []
  }
}

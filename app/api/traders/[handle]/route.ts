/**
 * 获取交易员详情 API
 *
 * 性能优化：
 * - 并行查询所有数据
 * - 内存缓存（5分钟TTL）
 * - 减少数据库往返
 *
 * 数据包括：
 * - 基本信息、绩效数据
 * - 资产偏好（7D/30D/90D）
 * - 收益率曲线（7D/30D/90D）
 * - 仓位历史记录
 * - 项目表现详细数据（夏普比率、跟单者盈亏等）
 * - tracked_since（Arena 首次追踪时间）
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { z } from 'zod'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import { createLogger } from '@/lib/utils/logger'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, handleError, withCache } from '@/lib/api/response'
import { getAggregatedStats, findUserByTrader } from '@/lib/data/linked-traders'

// 输入验证 schema（支持字母、数字、下划线、连字符、点、中文、0x 地址）
const handleSchema = z.string().min(1).max(255)

const logger = createLogger('trader-api')

// Next.js 缓存配置
export const revalidate = 300 // 5分钟，与 Cache-Control s-maxage 一致

// 缓存键前缀
const CACHE_PREFIX = 'trader:'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  const startTime = Date.now()

  try {
    const { handle: rawHandle } = await params

    const parsed = handleSchema.safeParse(rawHandle)
    if (!parsed.success) {
      throw ApiError.validation('Invalid handle parameter')
    }
    const handle = parsed.data

    const decodedHandle = decodeURIComponent(handle)

    // Accept optional ?source= param to disambiguate traders with same handle across exchanges
    const sourceParam = request.nextUrl.searchParams.get('source') || ''
    const cacheKey = `${CACHE_PREFIX}${decodedHandle.toLowerCase()}${sourceParam ? `:${sourceParam}` : ''}`

    // 检查缓存
    const cached = getServerCache<Record<string, unknown>>(cacheKey)
    if (cached) {
      const cachedData = await cached
      return apiSuccess({ ...cachedData, cached: true })
    }

    const supabase = getSupabaseAdmin()

    // ── Unified data layer: resolveTrader → getTraderDetail ──
    const resolved = await resolveTrader(supabase, {
      handle: decodedHandle,
      platform: sourceParam || undefined,
    })

    if (!resolved) {
      logger.warn(`No trader found for handle: ${decodedHandle}`)
      throw ApiError.notFound(`Trader not found: ${decodedHandle}`)
    }

    const detail = await getTraderDetail(supabase, {
      platform: resolved.platform,
      traderKey: resolved.traderKey,
    })

    if (!detail) {
      throw ApiError.notFound(`No data for trader: ${decodedHandle}`)
    }

    const data = toTraderPageData(detail)

    // ── include: bundle additional data into the response ──
    const includeParam = request.nextUrl.searchParams.get('include') || ''
    const includes = includeParam ? includeParam.split(',').map(s => s.trim().toLowerCase()) : []
    const extras: Record<string, unknown> = {}

    if (includes.length > 0) {
      const promises: Promise<void>[] = []

      // claim status
      if (includes.includes('claim')) {
        promises.push(
          (async () => {
            try {
              const traderId = resolved.traderKey
              const source = resolved.platform
              const { data: verified } = await supabase
                .from('verified_traders')
                .select('id, user_id, display_name, bio, avatar_url, twitter_url, telegram_url, discord_url, website_url')
                .eq('trader_id', traderId)
                .eq('source', source)
                .maybeSingle()

              if (!verified) {
                extras.claim_status = { is_verified: false }
              } else {
                extras.claim_status = {
                  is_verified: true,
                  owner_id: verified.user_id,
                  profile: {
                    display_name: verified.display_name,
                    bio: verified.bio,
                    avatar_url: verified.avatar_url,
                    twitter_url: verified.twitter_url,
                    telegram_url: verified.telegram_url,
                    discord_url: verified.discord_url,
                    website_url: verified.website_url,
                  },
                }
              }
            } catch (e) {
              logger.warn('include=claim failed', { error: e instanceof Error ? e.message : String(e) })
              extras.claim_status = { is_verified: false, _error: 'fetch_failed' }
            }
          })()
        )
      }

      // aggregate (multi-account)
      if (includes.includes('aggregate')) {
        promises.push(
          (async () => {
            try {
              const userId = await findUserByTrader(supabase, resolved.platform, resolved.traderKey)
              if (!userId) {
                extras.aggregate = { aggregated: null, accounts: [], totalAccounts: 0 }
              } else {
                const stats = await getAggregatedStats(supabase, userId)
                if (!stats) {
                  extras.aggregate = { aggregated: null, accounts: [], totalAccounts: 0 }
                } else {
                  extras.aggregate = {
                    aggregated: {
                      combinedPnl: stats.combinedPnl,
                      bestRoi: stats.bestRoi,
                      weightedScore: stats.weightedScore,
                    },
                    accounts: stats.accounts.map((a) => ({
                      id: a.id,
                      platform: a.platform,
                      traderKey: a.traderKey,
                      handle: a.handle,
                      label: a.label,
                      isPrimary: a.isPrimary,
                      roi: a.roi,
                      pnl: a.pnl,
                      arenaScore: a.arenaScore,
                      winRate: a.winRate,
                      maxDrawdown: a.maxDrawdown,
                      rank: a.rank,
                    })),
                    totalAccounts: stats.totalAccounts,
                  }
                }
              }
            } catch (e) {
              logger.warn('include=aggregate failed', { error: e instanceof Error ? e.message : String(e) })
              extras.aggregate = { aggregated: null, accounts: [], totalAccounts: 0, _error: 'fetch_failed' }
            }
          })()
        )
      }

      // rank history (sparkline)
      if (includes.includes('rank_history')) {
        promises.push(
          (async () => {
            try {
              const period = request.nextUrl.searchParams.get('rh_period') || '90D'
              const days = Math.min(Number(request.nextUrl.searchParams.get('rh_days') || '7'), 30)
              const cutoffDate = new Date()
              cutoffDate.setDate(cutoffDate.getDate() - days)
              const cutoffISO = cutoffDate.toISOString().split('T')[0]

              const { data: rhData, error: rhError } = await supabase
                .from('rank_history')
                .select('snapshot_date, rank, arena_score')
                .eq('platform', resolved.platform)
                .eq('trader_key', resolved.traderKey)
                .eq('period', period)
                .gte('snapshot_date', cutoffISO)
                .order('snapshot_date', { ascending: true })
                .limit(days)

              if (rhError) {
                logger.warn('include=rank_history query error', { error: rhError.message })
                extras.rank_history = { history: [], platform: resolved.platform, trader_key: resolved.traderKey, period, _error: 'query_failed' }
              } else {
                extras.rank_history = {
                  history: (rhData || []).map(row => ({
                    date: row.snapshot_date,
                    rank: row.rank,
                    arena_score: row.arena_score,
                  })),
                  platform: resolved.platform,
                  trader_key: resolved.traderKey,
                  period,
                }
              }
            } catch (e) {
              logger.warn('include=rank_history failed', { error: e instanceof Error ? e.message : String(e) })
              extras.rank_history = { history: [], _error: 'fetch_failed' }
            }
          })()
        )
      }

      await Promise.all(promises)
    }

    const responseData = { ...data as Record<string, unknown>, ...extras }

    // 缓存结果 (cache without extras to keep base data clean)
    setServerCache(cacheKey, data, CacheTTL.MEDIUM)

    const duration = Date.now() - startTime
    const response = apiSuccess({ ...responseData, cached: false, fetchTime: duration })
    return withCache(response, { maxAge: 300, staleWhileRevalidate: 600 })

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Trader API error', { error: errorMessage })
    return handleError(error, 'trader-detail')
  }
}

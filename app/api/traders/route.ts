/**
 * 获取排行榜交易员数据 API
 * 合并所有交易所数据，使用 Arena Score 排名算法
 * 支持 7D/30D/90D 时间段分别显示
 *
 * 性能优化（Vercel Pro）：
 * 1. Redis 缓存 - 60 秒 TTL，避免重复数据库查询
 * 2. Edge Runtime - 更快的冷启动和全球分布
 * 3. 带锁缓存 - 防止缓存击穿（cache stampede）
 *
 * 排名逻辑（统一在此处计算）：
 * 1. 从数据库获取各交易所最新快照数据
 * 2. 过滤超过 24 小时的陈旧数据
 * 3. 使用 Arena Score 算法计算分数
 * 4. 按分数降序 → 回撤小 → 胜率高 → trader_id 字母序排序（确保稳定性）
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import {
  calculateArenaScore,
  isWithinGracePeriod,
  debouncedConfidence,
  ARENA_CONFIG,
  type Period,
} from '@/lib/utils/arena-score'
import {
  ALL_SOURCES,
  SOURCE_TYPE_MAP,
  SKIP_PNL_THRESHOLD_SOURCES,
} from '@/lib/constants/exchanges'
import { createLogger } from '@/lib/utils/logger'
import { getOrSetWithLock, CacheKey } from '@/lib/cache'

const logger = createLogger('traders-api')

// Edge Runtime for faster cold starts (Vercel Pro)
export const runtime = 'edge'
export const preferredRegion = ['iad1', 'sfo1', 'hnd1'] // US East, US West, Tokyo

export const dynamic = 'force-dynamic'

// 数据时效性：只取最近 24 小时内的数据
const DATA_FRESHNESS_HOURS = 24

// 数据质量：ROI 超过此值视为异常数据（如 Hyperliquid 百万级 ROI）
const ROI_ANOMALY_THRESHOLD = 10000 // 10000% = 100x

interface TraderData {
  id: string
  handle: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number
  source: string
  source_type: 'futures' | 'spot' | 'web3'
  avatar_url: string | null
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
  last_qualified_at?: string | null
  full_confidence_at?: string | null
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    // 获取查询参数
    const searchParams = request.nextUrl.searchParams
    const timeRange = (searchParams.get('timeRange') || '90D') as Period
    const exchangeFilter = searchParams.get('exchange') // 可选：筛选特定交易所

    // Feature 1: Server-side pagination & sorting params
    const sortBy = searchParams.get('sortBy') as 'arena_score' | 'roi' | 'win_rate' | 'max_drawdown' | null
    const order = (searchParams.get('order') || 'desc') as 'asc' | 'desc'
    const page = Math.max(0, parseInt(searchParams.get('page') || '0', 10) || 0)
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '500', 10) || 500))

    // 生成缓存键
    const cacheKey = CacheKey.traders.list({
      timeRange,
      exchange: exchangeFilter || 'all',
      limit,
      page,
    }) + `:${sortBy || 'arena_score'}:${order}`

    // 尝试从缓存获取数据
    const cachedData = await getOrSetWithLock(
      cacheKey,
      async () => {
        // 缓存未命中，执行数据库查询
        return await fetchTradersData(supabase, {
          timeRange,
          exchangeFilter,
          sortBy,
          order,
          page,
          limit,
        })
      },
      { ttl: 120, lockTtl: 10 } // 120 秒缓存，10 秒锁超时
    )

    const response = NextResponse.json(cachedData)

    // 添加缓存头，提高页面加载速度
    response.headers.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300')
    response.headers.set('X-Cache-Key', cacheKey)

    return response
  },
  { name: 'traders', rateLimit: 'read' }
)

// 数据获取逻辑（抽取为单独函数以支持缓存）
async function fetchTradersData(
  supabase: ReturnType<typeof import('@/lib/supabase/server').getSupabaseAdmin>,
  params: {
    timeRange: Period
    exchangeFilter: string | null
    sortBy: 'arena_score' | 'roi' | 'win_rate' | 'max_drawdown' | null
    order: 'asc' | 'desc'
    page: number
    limit: number
  }
) {
  const { timeRange, exchangeFilter, sortBy, order, page, limit } = params

    const allTraders: TraderData[] = []
    const staleSources: string[] = [] // 跟踪陈旧数据的交易所

    // 计算数据时效性阈值
    const freshnessThreshold = new Date()
    freshnessThreshold.setHours(freshnessThreshold.getHours() - DATA_FRESHNESS_HOURS)
    const freshnessISO = freshnessThreshold.toISOString()

    // 某些 DEX 可能没有 90D 数据，但查询会返回空结果，不需要特殊排除
    // 让每个数据源自行处理（如果没有数据会返回空数组）
    let sourcesToQuery: string[] = [...ALL_SOURCES]

    // 如果指定了 exchange 参数，只查询该交易所
    if (exchangeFilter && (ALL_SOURCES as string[]).includes(exchangeFilter)) {
      sourcesToQuery = [exchangeFilter]
    }

    // 并行获取所有交易所数据（优化：每个 source 减少为 2 次查询）
    const sourcePromises = sourcesToQuery.map(async (source) => {
      const seasonId = timeRange

      // 查询 1: 检查数据新鲜度 — 单次查询获取最新 captured_at
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', source)
        .eq('season_id', seasonId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!latestSnapshot) return { traders: [], isStale: false }

      // 判断数据是否陈旧
      const isFresh = latestSnapshot.captured_at >= freshnessISO
      if (!isFresh) {
        logger.warn(`${source} 数据陈旧，最后更新: ${latestSnapshot.captured_at}`)
        staleSources.push(source)
      }

      // 查询 2: 获取所有快照数据 + trader_sources（一次性分页）
      const allSnapshots = []
      let dbPage = 0
      const pageSize = 1000

      while (true) {
        const { data, error } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id, roi, pnl, followers, win_rate, max_drawdown, trades_count, arena_score, captured_at, last_qualified_at, full_confidence_at')
          .eq('source', source)
          .eq('season_id', seasonId)
          .order('captured_at', { ascending: false })
          .range(dbPage * pageSize, (dbPage + 1) * pageSize - 1)

        if (error) {
          console.error(`[Traders API] ${source} 查询错误:`, error.message)
          break
        }

        if (!data?.length) break

        allSnapshots.push(...data)
        if (data.length < pageSize) break
        dbPage++
      }

      if (!allSnapshots.length) return { traders: [], isStale: !isFresh }

      // 去重：每个交易员只保留最新的一条记录
      // 同时合并 last_qualified_at 和 full_confidence_at（取所有快照中最新的值）
      const traderMap = new Map()
      allSnapshots.forEach(snap => {
        if (!traderMap.has(snap.source_trader_id)) {
          traderMap.set(snap.source_trader_id, snap)
        } else {
          // 合并 qualification tracking 字段（保留最新的时间戳）
          const existing = traderMap.get(snap.source_trader_id)
          if (snap.last_qualified_at &&
              (!existing.last_qualified_at || snap.last_qualified_at > existing.last_qualified_at)) {
            existing.last_qualified_at = snap.last_qualified_at
          }
          if (snap.full_confidence_at &&
              (!existing.full_confidence_at || snap.full_confidence_at > existing.full_confidence_at)) {
            existing.full_confidence_at = snap.full_confidence_at
          }
        }
      })
      const snapshots = Array.from(traderMap.values())

      if (!snapshots.length) {
        logger.warn(`${source} 无有效数据`)
        return { traders: [], isStale: !isFresh }
      }

      // 查询 3: 批量获取 handles 和头像
      const traderIds = snapshots.map(s => s.source_trader_id)
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, avatar_url, profile_url')
        .eq('source', source)
        .in('source_trader_id', traderIds)

      const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
      sources?.forEach((s: { source_trader_id: string; handle: string | null; avatar_url: string | null; profile_url: string | null }) => {
        handleMap.set(s.source_trader_id, { handle: s.handle, avatar_url: s.avatar_url || null })
      })

      // 构建交易员数据
      const traders = snapshots
        .filter(item => {
          const roi = item.roi ?? 0
          if (Math.abs(roi) > ROI_ANOMALY_THRESHOLD) return false
          return true
        })
        .map(item => {
          const info = handleMap.get(item.source_trader_id) || { handle: null, avatar_url: null }
          // 标准化 win_rate 为百分比形式
          const normalizedWinRate = item.win_rate != null
            ? (item.win_rate <= 1 ? item.win_rate * 100 : item.win_rate)
            : null

          return {
            id: item.source_trader_id,
            handle: info.handle || item.source_trader_id,
            roi: item.roi ?? 0,
            pnl: item.pnl ?? 0,
            win_rate: normalizedWinRate,
            max_drawdown: item.max_drawdown,
            trades_count: item.trades_count,
            followers: item.followers ?? null,
            source,
            source_type: SOURCE_TYPE_MAP[source] || 'futures',
            avatar_url: info.avatar_url,
            // 使用数据库预计算的 arena_score（如果存在）
            arena_score: item.arena_score != null ? Number(item.arena_score) : undefined,
            // 排行榜稳定性字段
            last_qualified_at: item.last_qualified_at ?? null,
            full_confidence_at: item.full_confidence_at ?? null,
          }
        })
      return { traders, isStale: !isFresh }
    })

    // 等待所有查询完成并去重
    const results = await Promise.all(sourcePromises)
    const seenTraders = new Set<string>()
    results.forEach(result => {
      result.traders.forEach(trader => {
        // 使用 source + id 作为唯一键去重
        const key = `${trader.source}:${trader.id}`
        if (!seenTraders.has(key)) {
          seenTraders.add(key)
          allTraders.push(trader)
        }
      })
    })
    

    // 统一排名计算逻辑：
    // 1. 计算每个交易员的 Arena Score
    // 2. 过滤未达 PnL 门槛的交易员
    // 3. 按稳定的多级排序规则排序（避免同分时排名跳动）
    
    const pnlThreshold = ARENA_CONFIG.PNL_THRESHOLD[timeRange]
    
    const scoredTraders = allTraders
      .map(trader => {
        const scoreResult = calculateArenaScore(
          {
            roi: trader.roi,
            pnl: trader.pnl,
            maxDrawdown: trader.max_drawdown,
            winRate: trader.win_rate,
          },
          timeRange
        )

        // 方案 3：置信度防抖 — 如果近期（8h 内）曾有完整数据，继续使用 full 置信度
        const effectiveConfidence = debouncedConfidence(
          scoreResult.scoreConfidence,
          trader.full_confidence_at,
        )
        const confidenceMultiplier = ARENA_CONFIG.CONFIDENCE_MULTIPLIER[effectiveConfidence]

        // 方案 2：软 PnL 门槛 — 对需要 PnL 门槛的交易所，应用 qualifier 系数
        const skipPnlThreshold = (SKIP_PNL_THRESHOLD_SOURCES as string[]).includes(trader.source)
        const qualifier = skipPnlThreshold ? 1 : scoreResult.pnlQualifier

        // 计算最终分数：原始子分数之和 × 置信度乘数 × PnL qualifier
        const rawSubScores = scoreResult.returnScore + scoreResult.pnlScore +
                             scoreResult.drawdownScore + scoreResult.stabilityScore
        const finalScore = Math.round(
          Math.max(0, Math.min(100, rawSubScores * confidenceMultiplier * qualifier)) * 100
        ) / 100

        return {
          ...trader,
          arena_score: finalScore,
          return_score: scoreResult.returnScore,
          pnl_score: scoreResult.pnlScore,
          drawdown_score: scoreResult.drawdownScore,
          stability_score: scoreResult.stabilityScore,
          _meetsThreshold: scoreResult.meetsThreshold,
          _pnlQualifier: qualifier,
          _skipPnlThreshold: skipPnlThreshold,
        }
      })
      // 方案 1+2：过滤 — 跳过 PnL 门槛的交易所直接通过，
      // 否则需要达到软门槛 OR 在 24h 保留窗口内
      .filter(t => {
        if (t._skipPnlThreshold) return true
        if (t._meetsThreshold) return true
        // 方案 1：Grace period — 24h 内合格过就保留
        if (isWithinGracePeriod(t.last_qualified_at)) return true
        return false
      })
      // 稳定排序：确保相同数据产生相同排名
      .sort((a, b) => {
        // 1. 主排序：Arena Score 降序
        const scoreDiff = b.arena_score - a.arena_score
        if (Math.abs(scoreDiff) > 0.01) {
          return scoreDiff
        }
        
        // 2. 次排序：回撤小的优先（绝对值）
        const mddA = Math.abs(a.max_drawdown ?? 100)
        const mddB = Math.abs(b.max_drawdown ?? 100)
        if (mddA !== mddB) {
          return mddA - mddB
        }
        
        // 3. 三级排序：胜率高的优先
        const winRateA = a.win_rate ?? 0
        const winRateB = b.win_rate ?? 0
        if (winRateA !== winRateB) {
          return winRateB - winRateA
        }
        
        // 4. 四级排序：PnL 高的优先
        if (a.pnl !== b.pnl) {
          return b.pnl - a.pnl
        }
        
        // 5. 最终排序：按 trader ID 字母序（确保完全稳定）
        return a.id.localeCompare(b.id)
      })

    // Feature 1: Re-sort if sortBy is specified and differs from arena_score
    if (sortBy && sortBy !== 'arena_score') {
      scoredTraders.sort((a, b) => {
        let aVal = 0, bVal = 0
        switch (sortBy) {
          case 'roi': aVal = a.roi ?? 0; bVal = b.roi ?? 0; break
          case 'win_rate': aVal = a.win_rate ?? 0; bVal = b.win_rate ?? 0; break
          case 'max_drawdown': aVal = Math.abs(a.max_drawdown ?? 0); bVal = Math.abs(b.max_drawdown ?? 0); break
        }
        return order === 'desc' ? bVal - aVal : aVal - bVal
      })
    } else if (order === 'asc') {
      scoredTraders.reverse()
    }

    // Feature 7: Duplicate trader detection - group by handle across sources
    const handleSourceMap = new Map<string, string[]>()
    scoredTraders.forEach(trader => {
      const handle = trader.handle || trader.id
      // Skip wallet addresses (0x...)
      if (handle.startsWith('0x') && handle.length > 20) return
      const existing = handleSourceMap.get(handle.toLowerCase()) || []
      if (!existing.includes(trader.source)) {
        existing.push(trader.source)
      }
      handleSourceMap.set(handle.toLowerCase(), existing)
    })

    // Feature 1: Paginate
    const totalScored = scoredTraders.length
    const startIdx = page * limit
    const paginatedTraders = scoredTraders.slice(startIdx, startIdx + limit)
    const hasMore = startIdx + limit < totalScored

    // Feature 3: Rank change indicators - query yesterday's data
    let rankChangeMap: Map<string, number> | null = null
    let newTraderSet: Set<string> | null = null
    try {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      const yesterdayStart = new Date(yesterday)
      yesterdayStart.setHours(0, 0, 0, 0)
      const yesterdayEnd = new Date(yesterday)
      yesterdayEnd.setHours(23, 59, 59, 999)

      // Get yesterday's snapshot trader IDs ordered by arena_score
      const { data: yesterdaySnapshots } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, source, arena_score')
        .gte('captured_at', yesterdayStart.toISOString())
        .lte('captured_at', yesterdayEnd.toISOString())
        .order('arena_score', { ascending: false })
        .limit(500)

      if (yesterdaySnapshots?.length) {
        // Dedupe yesterday's data and build rank map
        const yesterdayRanks = new Map<string, number>()
        const seenYesterday = new Set<string>()
        let rank = 1
        for (const snap of yesterdaySnapshots) {
          const key = `${snap.source}:${snap.source_trader_id}`
          if (!seenYesterday.has(key)) {
            seenYesterday.add(key)
            yesterdayRanks.set(key, rank++)
          }
        }

        rankChangeMap = new Map()
        newTraderSet = new Set()

        paginatedTraders.forEach((trader, idx) => {
          const key = `${trader.source}:${trader.id}`
          const currentRank = startIdx + idx + 1
          const prevRank = yesterdayRanks.get(key)
          if (prevRank != null) {
            // Positive = moved up (rank number decreased)
            rankChangeMap!.set(key, prevRank - currentRank)
          } else {
            newTraderSet!.add(key)
          }
        })
      }
    } catch (err: unknown) {
      logger.warn('Failed to compute rank changes:', err)
    }

    // Build final trader objects with all features, removing internal fields
    const topTraders = paginatedTraders.map(({ _meetsThreshold, _pnlQualifier, _skipPnlThreshold, last_qualified_at, full_confidence_at, ...t }) => {
      const key = `${t.source}:${t.id}`
      const handle = t.handle || t.id
      const handleLower = handle.toLowerCase()

      // Feature 7: also_on
      const allSources = handleSourceMap.get(handleLower) || []
      const alsoOn = allSources.filter(s => s !== t.source)

      return {
        ...t,
        // Feature 3: rank change
        rank_change: rankChangeMap?.get(key) ?? null,
        is_new: newTraderSet?.has(key) ?? false,
        // Feature 7: duplicate detection
        also_on: alsoOn.length > 0 ? alsoOn : undefined,
      }
    })

    // 获取最新数据的时间戳（用于前端显示）
    const { data: latestData } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // 检查数据是否陈旧（有任何交易所数据超过 24 小时）
    const isStale = staleSources.length > 0

    // 收集所有有数据的来源
    const allAvailableSources = [...new Set(allTraders.map(t => t.source))].sort()

    // 返回数据对象（用于缓存）
    return {
      traders: topTraders,
      timeRange,
      totalCount: allTraders.length,
      rankingMode: 'arena_score',
      pnlThreshold,
      lastUpdated: latestData?.captured_at || new Date().toISOString(),
      // 数据新鲜度标识
      isStale,
      staleSources: isStale ? staleSources : undefined,
      // Feature 1: Pagination metadata
      page,
      limit,
      hasMore,
      // 所有有数据的来源（用于底部来源显示）
      availableSources: allAvailableSources,
    }
}

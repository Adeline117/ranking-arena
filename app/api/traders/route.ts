/**
 * 获取排行榜交易员数据 API
 * 合并所有交易所数据，使用 Arena Score 排名算法
 * 支持 7D/30D/90D 时间段分别显示
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
  ARENA_CONFIG, 
  type Period,
} from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('traders-api')

export const dynamic = 'force-dynamic'

// 支持的交易所（新的 source 命名）
const ALL_SOURCES = [
  // Binance
  'binance_futures',
  'binance_spot',
  'binance_web3',
  // Bybit
  'bybit',
  // Bitget
  'bitget_futures',
  'bitget_spot',
  // 其他平台
  'mexc',
  'coinex',
  'okx_web3',
  'kucoin',
  'gmx',
]

// 需要特殊处理 PnL 门槛的交易所
// 这些交易所的 API 不返回 PnL 数据或 PnL 含义不同
const SKIP_PNL_THRESHOLD_SOURCES = [
  'bybit',          // PnL 是跟单者盈亏，不是交易员自身盈亏
  'bitget_futures', // API 不返回 PnL 数据
  'bitget_spot',    // API 不返回 PnL 数据
  'kucoin',         // API 不返回 PnL 数据
  'coinex',         // PnL 数据不完整
  'mexc',           // API 不返回 PnL 数据
  'gmx',            // 链上数据，PnL 计算方式不同
  'okx_web3',       // 链上数据，PnL 计算方式不同
]

// 数据时效性：只取最近 24 小时内的数据
const DATA_FRESHNESS_HOURS = 24

// source 类型映射（用于前端显示）
const SOURCE_TYPE_MAP: Record<string, 'futures' | 'spot' | 'web3'> = {
  'binance_futures': 'futures',
  'binance_spot': 'spot',
  'binance_web3': 'web3',
  'bybit': 'futures',
  'bitget_futures': 'futures',
  'bitget_spot': 'spot',
  'mexc': 'futures',
  'coinex': 'futures',
  'okx_web3': 'web3',
  'kucoin': 'futures',
  'gmx': 'web3',
}

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
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '100', 10) || 100))

    const allTraders: TraderData[] = []
    const staleSources: string[] = [] // 跟踪陈旧数据的交易所

    // 计算数据时效性阈值
    const freshnessThreshold = new Date()
    freshnessThreshold.setHours(freshnessThreshold.getHours() - DATA_FRESHNESS_HOURS)
    const freshnessISO = freshnessThreshold.toISOString()

    // GMX 特殊处理：只有 7D 和 30D 数据
    let sourcesToQuery = timeRange === '90D' 
      ? ALL_SOURCES.filter(s => s !== 'gmx')
      : ALL_SOURCES
    
    // 如果指定了 exchange 参数，只查询该交易所
    if (exchangeFilter && ALL_SOURCES.includes(exchangeFilter as typeof ALL_SOURCES[number])) {
      sourcesToQuery = [exchangeFilter as typeof ALL_SOURCES[number]]
    }

    // 并行获取所有交易所数据
    const sourcePromises = sourcesToQuery.map(async (source) => {
      // 所有交易所都使用 season_id 过滤
      const seasonId = timeRange

      // 获取最新 captured_at（必须在时效范围内）
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', source)
        .eq('season_id', seasonId)
        .gte('captured_at', freshnessISO)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        
      if (!latestSnapshot) {
        // 如果没有新数据，尝试获取最近的数据（不限时效，但会标记为陈旧）
        const { data: fallbackSnapshot } = await supabase
          .from('trader_snapshots')
          .select('captured_at')
          .eq('source', source)
          .eq('season_id', seasonId)
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (!fallbackSnapshot) return { traders: [], isStale: false }

        // 使用陈旧数据但继续处理，标记该交易所数据为陈旧
        logger.warn(`${source} 数据陈旧，最后更新: ${fallbackSnapshot.captured_at}`)
        staleSources.push(source)
      }
      
      const capturedAt = latestSnapshot?.captured_at || (await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', source)
        .eq('season_id', seasonId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()).data?.captured_at

      if (!capturedAt) return { traders: [], isStale: false }

      // 使用分页查询获取所有数据（Supabase默认限制1000条）
      const allSnapshots = []
      let page = 0
      const pageSize = 1000
      
      while (true) {
        const { data, error } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id, roi, pnl, followers, win_rate, max_drawdown, trades_count, arena_score, captured_at')
          .eq('source', source)
          .eq('season_id', seasonId)
          .order('captured_at', { ascending: false })
          .range(page * pageSize, (page + 1) * pageSize - 1)
        
        if (error) {
          console.error(`[Traders API] ${source} 查询错误:`, error.message)
          break
        }
        
        if (!data?.length) break
        
        allSnapshots.push(...data)
        if (data.length < pageSize) break
        page++
      }
      
      if (!allSnapshots.length) return { traders: [], isStale: false }
      
      // 去重：每个交易员只保留最新的一条记录
      const traderMap = new Map()
      allSnapshots.forEach(snap => {
        if (!traderMap.has(snap.source_trader_id)) {
          traderMap.set(snap.source_trader_id, snap)
        }
      })
      const snapshots = Array.from(traderMap.values())

      if (!snapshots?.length) {
        logger.warn(`${source} 无有效数据`)
        return { traders: [], isStale: false }
      }

      // 批量获取 handles
      const traderIds = snapshots.map(s => s.source_trader_id)
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', source)
        .in('source_trader_id', traderIds)

      const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
      sources?.forEach((s: { source_trader_id: string; handle: string | null; profile_url: string | null }) => {
        // profile_url 存储的是头像图片 URL（由抓取脚本保存）
        handleMap.set(s.source_trader_id, { handle: s.handle, avatar_url: s.profile_url })
      })

      // 构建交易员数据（不包含数据库 rank，排名将在后面统一计算）
      const traders = snapshots.map(item => {
        const info = handleMap.get(item.source_trader_id) || { handle: null, avatar_url: null }
        // 标准化 win_rate 为百分比形式
        // binance_futures 存储小数(0.85)，bitget/bybit 存储百分比(85)
        const normalizedWinRate = item.win_rate != null
          ? (item.win_rate <= 1 ? item.win_rate * 100 : item.win_rate)
          : null

        return {
          id: item.source_trader_id,
          handle: info.handle || item.source_trader_id,
          roi: item.roi ?? 0,
          pnl: item.pnl ?? 0,
          win_rate: normalizedWinRate,  // 统一为百分比形式
          max_drawdown: item.max_drawdown,
          trades_count: item.trades_count,
          followers: item.followers ?? null,  // 保留 null，GMX 无跟单功能
          source,
          source_type: SOURCE_TYPE_MAP[source] || 'futures',
          avatar_url: info.avatar_url,  // 只使用数据库中的原始头像
        }
      })
      return { traders, isStale: !latestSnapshot }
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
        
        return {
          ...trader,
          arena_score: scoreResult.totalScore,
          return_score: scoreResult.returnScore,
          drawdown_score: scoreResult.drawdownScore,
          stability_score: scoreResult.stabilityScore,
          _meetsThreshold: scoreResult.meetsThreshold,
        }
      })
      // 过滤未达门槛的（某些交易所的 PnL 是跟单者盈亏，特殊处理）
      .filter(t => SKIP_PNL_THRESHOLD_SOURCES.includes(t.source) || t._meetsThreshold)
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
    } catch (err) {
      logger.warn('Failed to compute rank changes:', err)
    }

    // Build final trader objects with all features, removing internal fields
    const topTraders = paginatedTraders.map(({ _meetsThreshold, ...t }) => {
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

    const response = NextResponse.json({
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
    })

    // 添加缓存头，提高页面加载速度
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')

    return response
  },
  { name: 'traders', rateLimit: 'read' }
)

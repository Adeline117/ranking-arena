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

    const allTraders: TraderData[] = []
    
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
        
        if (!fallbackSnapshot) return []
        
        // 使用陈旧数据但继续处理
        console.warn(`[Traders API] ${source} 数据陈旧，最后更新: ${fallbackSnapshot.captured_at}`)
      }
      
      const capturedAt = latestSnapshot?.captured_at || (await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', source)
        .eq('season_id', seasonId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()).data?.captured_at

      if (!capturedAt) return []

      // 查询该来源所有快照数据，按 arena_score 排序
      // 每个交易员只取最新一条（通过后续去重实现）
      const { data: allSnapshots, error } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, roi, pnl, followers, win_rate, max_drawdown, trades_count, arena_score, captured_at')
        .eq('source', source)
        .eq('season_id', seasonId)
        .order('captured_at', { ascending: false })
        .limit(1000)
      
      if (error || !allSnapshots?.length) {
        if (error) console.error(`[Traders API] ${source} 查询错误:`, error.message)
        return []
      }
      
      // 去重：每个交易员只保留最新的一条记录
      const traderMap = new Map()
      allSnapshots.forEach(snap => {
        if (!traderMap.has(snap.source_trader_id)) {
          traderMap.set(snap.source_trader_id, snap)
        }
      })
      const snapshots = Array.from(traderMap.values())

      if (error || !snapshots?.length) {
        if (error) console.error(`[Traders API] ${source} 查询错误:`, error.message)
        return []
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
      return snapshots.map(item => {
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
          followers: item.followers || 0,
          source,
          source_type: SOURCE_TYPE_MAP[source] || 'futures',
          avatar_url: info.avatar_url,  // 只使用数据库中的原始头像
        }
      })
    })

    // 等待所有查询完成并去重
    const results = await Promise.all(sourcePromises)
    const seenTraders = new Set<string>()
    results.forEach(traders => {
      traders.forEach(trader => {
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

    // 取前 100 名，移除内部字段
    const topTraders = scoredTraders.slice(0, 100).map(({ _meetsThreshold, ...t }) => t)

    // 获取最新数据的时间戳（用于前端显示）
    const { data: latestData } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const response = NextResponse.json({ 
      traders: topTraders,
      timeRange,
      totalCount: allTraders.length,
      rankingMode: 'arena_score',
      pnlThreshold,
      lastUpdated: latestData?.captured_at || new Date().toISOString(),
    })
    
    // 添加缓存头，提高页面加载速度
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    
    return response
  },
  { name: 'traders', rateLimit: 'read' }
)

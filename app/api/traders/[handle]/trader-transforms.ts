/**
 * Data transformation and detail fetching for the trader detail API.
 * Extracts getTraderDetails and getTraderDetailsFromSnapshots.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateArenaScore, calculateOverallScore } from '@/lib/utils/arena-score'
import type {
  TraderSource,
  SnapshotData,
  AssetBreakdownItem,
  EquityCurvePoint,
  PortfolioItem,
  PositionHistoryItem,
  StatsDetailData,
} from './trader-types'
import { type SourceType, getSourceAliases, withTimeout, safeQuery } from './trader-queries'

// 辅助函数：标准化 win_rate 为百分比
function normalizeWinRate(wr: number | null): number | null {
  if (wr == null) return null
  return wr <= 1 ? wr * 100 : wr
}

// 获取交易员详细数据
export async function getTraderDetails(
  supabase: SupabaseClient,
  source: TraderSource,
  sourceType: SourceType
) {
  const traderId = source.source_trader_id
  const traderHandle = source.handle || source.source_trader_id

  // Parallel获取所有数据（10s 超时保护）
  const [
    snapshotResult,
    snapshot7dResult,
    snapshot30dResult,
    arenaFollowersResult,
    userProfileResult,
    portfolioResult,
    positionHistoryResult,
    postsResult,
    assetBreakdown90dResult,
    assetBreakdown30dResult,
    assetBreakdown7dResult,
    equityCurve90dResult,
    equityCurve30dResult,
    equityCurve7dResult,
    statsDetailResult,
    trackedSinceResult,
    v3ScoresResult,
  ] = await withTimeout(Promise.all([
    supabase.from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown, trades_count, followers, captured_at, season_id, profitability_score, risk_control_score, execution_score, arena_score, arena_score_v3, score_completeness, score_penalty')
      .eq('source', sourceType).eq('source_trader_id', traderId)
      .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown, trades_count')
      .eq('source', sourceType).eq('source_trader_id', traderId).eq('season_id', '7D')
      .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('trader_snapshots')
      .select('roi, pnl, win_rate, max_drawdown, trades_count')
      .eq('source', sourceType).eq('source_trader_id', traderId).eq('season_id', '30D')
      .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('trader_follows')
      .select('id', { count: 'exact', head: true }).eq('trader_id', traderId),
    supabase.from('user_profiles')
      .select('id, bio').eq('handle', traderHandle).maybeSingle(),
    safeQuery(() => supabase.from('trader_portfolio')
      .select('symbol, direction, invested_pct, entry_price, pnl')
      .in('source', getSourceAliases(sourceType)).eq('source_trader_id', traderId)
      .order('captured_at', { ascending: false }).limit(50)),
    safeQuery(() => supabase.from('trader_position_history')
      .select('symbol, direction, position_type, margin_mode, open_time, close_time, entry_price, exit_price, max_position_size, closed_size, pnl_usd, pnl_pct, status')
      .in('source', getSourceAliases(sourceType)).eq('source_trader_id', traderId)
      .order('open_time', { ascending: false }).limit(100)),
    supabase.from('posts')
      .select('id, title, content, created_at, group_id, like_count, is_pinned, groups(name)')
      .eq('author_handle', traderHandle).order('created_at', { ascending: false }).limit(20),
    safeQuery(() => supabase.from('trader_asset_breakdown')
      .select('symbol, weight_pct, period').in('source', getSourceAliases(sourceType))
      .eq('source_trader_id', traderId).eq('period', '90D')
      .order('weight_pct', { ascending: false }).limit(20)),
    safeQuery(() => supabase.from('trader_asset_breakdown')
      .select('symbol, weight_pct, period').in('source', getSourceAliases(sourceType))
      .eq('source_trader_id', traderId).eq('period', '30D')
      .order('weight_pct', { ascending: false }).limit(20)),
    safeQuery(() => supabase.from('trader_asset_breakdown')
      .select('symbol, weight_pct, period').in('source', getSourceAliases(sourceType))
      .eq('source_trader_id', traderId).eq('period', '7D')
      .order('weight_pct', { ascending: false }).limit(20)),
    safeQuery(() => supabase.from('trader_equity_curve')
      .select('data_date, roi_pct, pnl_usd').in('source', getSourceAliases(sourceType))
      .eq('source_trader_id', traderId).eq('period', '90D')
      .order('data_date', { ascending: true }).limit(90)),
    safeQuery(() => supabase.from('trader_equity_curve')
      .select('data_date, roi_pct, pnl_usd').in('source', getSourceAliases(sourceType))
      .eq('source_trader_id', traderId).eq('period', '30D')
      .order('data_date', { ascending: true }).limit(30)),
    safeQuery(() => supabase.from('trader_equity_curve')
      .select('data_date, roi_pct, pnl_usd').in('source', getSourceAliases(sourceType))
      .eq('source_trader_id', traderId).eq('period', '7D')
      .order('data_date', { ascending: true }).limit(7)),
    safeQuery(() => supabase.from('trader_stats_detail')
      .select('sharpe_ratio, copiers_pnl, copiers_count, winning_positions, total_positions, avg_holding_time_hours, avg_profit, avg_loss, period')
      .in('source', getSourceAliases(sourceType)).eq('source_trader_id', traderId)
      .order('captured_at', { ascending: false }).limit(3)),
    supabase.from('trader_snapshots')
      .select('captured_at').eq('source', sourceType).eq('source_trader_id', traderId)
      .order('captured_at', { ascending: true }).limit(1).maybeSingle(),
    supabase.from('trader_snapshots')
      .select('profitability_score, risk_control_score, execution_score, arena_score_v3, score_completeness, score_penalty')
      .eq('source', sourceType).eq('source_trader_id', traderId)
      .not('profitability_score', 'is', null)
      .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
  ]), 10000)

  let snapshot = snapshotResult.data as SnapshotData | null
  let snapshot7d = snapshot7dResult.data as SnapshotData | null
  let snapshot30d = snapshot30dResult.data as SnapshotData | null

  // Fallback to leaderboard_ranks when trader_snapshots has no/empty data
  const isEmptySnapshot = !snapshot ||
    ((snapshot.roi === 0 || snapshot.roi == null) &&
     (snapshot.win_rate === 0 || snapshot.win_rate == null) &&
     (snapshot.pnl == null || Math.abs(snapshot.pnl as number) < 0.01))
  if (isEmptySnapshot) {
    const { data: lrRows } = await supabase
      .from('leaderboard_ranks')
      .select('season_id, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, profitability_score, risk_control_score, execution_score')
      .eq('source', sourceType).eq('source_trader_id', traderId).limit(5)

    if (lrRows && lrRows.length > 0) {
      const lr90 = lrRows.find((r: Record<string, unknown>) => r.season_id === '90D')
      const lr30 = lrRows.find((r: Record<string, unknown>) => r.season_id === '30D')
      const lr7 = lrRows.find((r: Record<string, unknown>) => r.season_id === '7D')
      const best = lr90 || lr30 || lr7 || lrRows[0]

      const mapLR = (lr: Record<string, unknown>): SnapshotData => ({
        roi: lr.roi as number | null,
        pnl: lr.pnl as number | null,
        win_rate: lr.win_rate as number | null,
        max_drawdown: lr.max_drawdown as number | null,
        trades_count: lr.trades_count as number | null,
        followers: lr.followers as number | null,
        arena_score: lr.arena_score as number | null,
        profitability_score: lr.profitability_score as number | null,
        risk_control_score: lr.risk_control_score as number | null,
        execution_score: lr.execution_score as number | null,
      })

      if (best) snapshot = mapLR(best)
      if (lr7) snapshot7d = mapLR(lr7)
      if (lr30) snapshot30d = mapLR(lr30)
    }
  }

  const arenaFollowers = arenaFollowersResult.count || 0
  const userProfile = userProfileResult.data
  const portfolioData = (portfolioResult || []) as PortfolioItem[]
  const positionHistoryData = (positionHistoryResult || []) as PositionHistoryItem[]
  const posts = postsResult.data || []

  const assetBreakdown90d = (assetBreakdown90dResult || []) as AssetBreakdownItem[]
  const assetBreakdown30d = (assetBreakdown30dResult || []) as AssetBreakdownItem[]
  const assetBreakdown7d = (assetBreakdown7dResult || []) as AssetBreakdownItem[]

  const equityCurve90d = (equityCurve90dResult || []) as EquityCurvePoint[]
  const equityCurve30d = (equityCurve30dResult || []) as EquityCurvePoint[]
  const equityCurve7d = (equityCurve7dResult || []) as EquityCurvePoint[]

  const statsDetailList = (statsDetailResult || []) as StatsDetailData[]
  const statsDetail90d = statsDetailList.find(s => s.period === '90D') || statsDetailList[0]
  const statsDetail30d = statsDetailList.find(s => s.period === '30D')
  const statsDetail7d = statsDetailList.find(s => s.period === '7D')

  const trackedSince = trackedSinceResult.data?.captured_at || null

  const v3Scores = v3ScoresResult.data as {
    profitability_score: number | null
    risk_control_score: number | null
    execution_score: number | null
    arena_score_v3: number | null
    score_completeness: string | null
    score_penalty: number | null
  } | null

  // 获取相似交易员
  const similarTraders = await fetchSimilarTraders(
    supabase, sourceType, traderId, traderHandle, snapshot
  )

  // 计算各时间段的 Arena Score
  const score90d = snapshot?.roi != null && snapshot?.pnl != null
    ? calculateArenaScore({
        roi: snapshot.roi * 100,
        pnl: snapshot.pnl,
        maxDrawdown: snapshot.max_drawdown,
        winRate: normalizeWinRate(snapshot.win_rate),
      }, '90D')
    : null

  const score30d = snapshot30d?.roi != null && snapshot30d?.pnl != null
    ? calculateArenaScore({
        roi: snapshot30d.roi * 100,
        pnl: snapshot30d.pnl,
        maxDrawdown: snapshot30d.max_drawdown,
        winRate: normalizeWinRate(snapshot30d.win_rate),
      }, '30D')
    : null

  const score7d = snapshot7d?.roi != null && snapshot7d?.pnl != null
    ? calculateArenaScore({
        roi: snapshot7d.roi * 100,
        pnl: snapshot7d.pnl,
        maxDrawdown: snapshot7d.max_drawdown,
        winRate: normalizeWinRate(snapshot7d.win_rate),
      }, '7D')
    : null

  const overallScore = calculateOverallScore({
    score7d: score7d?.totalScore ?? null,
    score30d: score30d?.totalScore ?? null,
    score90d: score90d?.totalScore ?? null,
  })

  return buildTraderResponse({
    traderHandle, traderId, sourceType, source,
    snapshot, snapshot7d, snapshot30d,
    arenaFollowers, userProfile,
    portfolioData, positionHistoryData, posts,
    assetBreakdown90d, assetBreakdown30d, assetBreakdown7d,
    equityCurve90d, equityCurve30d, equityCurve7d,
    statsDetail90d, statsDetail30d, statsDetail7d,
    trackedSince, v3Scores, similarTraders,
    score90d, score30d, score7d, overallScore,
  })
}

// 从 trader_snapshots 获取交易员数据（回退方案）
export async function getTraderDetailsFromSnapshots(
  supabase: SupabaseClient,
  traderId: string,
  sourceType: SourceType
) {
  let snapshotQueryResults: unknown[] = [
    { data: null }, { data: null }, { data: null },
    { count: 0 }, { data: null }, { data: null },
  ]
  try {
    snapshotQueryResults = await withTimeout(Promise.all([
      supabase.from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown, trades_count, followers, captured_at, season_id')
        .eq('source', sourceType).eq('source_trader_id', traderId)
        .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown, trades_count')
        .eq('source', sourceType).eq('source_trader_id', traderId).eq('season_id', '7D')
        .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown, trades_count')
        .eq('source', sourceType).eq('source_trader_id', traderId).eq('season_id', '30D')
        .order('captured_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('trader_follows')
        .select('id', { count: 'exact', head: true }).eq('trader_id', traderId),
      supabase.from('trader_snapshots')
        .select('captured_at').eq('source', sourceType).eq('source_trader_id', traderId)
        .order('captured_at', { ascending: true }).limit(1).maybeSingle(),
      supabase.from('trader_sources')
        .select('avatar_url').eq('source', sourceType).eq('source_trader_id', traderId)
        .limit(1).maybeSingle(),
    ]), 8000)
  } catch {
    // timeout — use null defaults
  }
  const [snapshotResult, snapshot7dResult, snapshot30dResult, arenaFollowersResult, trackedSinceResult, avatarResult] = snapshotQueryResults as [
    { data: SnapshotData | null },
    { data: SnapshotData | null },
    { data: SnapshotData | null },
    { count?: number | null },
    { data: { captured_at?: string | null } | null },
    { data: { avatar_url?: string | null } | null },
  ]

  const snapshot = snapshotResult.data
  const snapshot7d = snapshot7dResult.data
  const snapshot30d = snapshot30dResult.data
  const arenaFollowers = arenaFollowersResult.count || 0
  const trackedSince = trackedSinceResult.data?.captured_at || null
  const avatarUrl = avatarResult.data?.avatar_url || null

  const score90d = snapshot?.roi != null && snapshot?.pnl != null
    ? calculateArenaScore({
        roi: snapshot.roi * 100,
        pnl: snapshot.pnl,
        maxDrawdown: snapshot.max_drawdown,
        winRate: normalizeWinRate(snapshot.win_rate),
      }, '90D')
    : null

  const score30d = snapshot30d?.roi != null && snapshot30d?.pnl != null
    ? calculateArenaScore({
        roi: snapshot30d.roi * 100,
        pnl: snapshot30d.pnl,
        maxDrawdown: snapshot30d.max_drawdown,
        winRate: normalizeWinRate(snapshot30d.win_rate),
      }, '30D')
    : null

  const score7d = snapshot7d?.roi != null && snapshot7d?.pnl != null
    ? calculateArenaScore({
        roi: snapshot7d.roi * 100,
        pnl: snapshot7d.pnl,
        maxDrawdown: snapshot7d.max_drawdown,
        winRate: normalizeWinRate(snapshot7d.win_rate),
      }, '7D')
    : null

  const overallScore = calculateOverallScore({
    score7d: score7d?.totalScore ?? null,
    score30d: score30d?.totalScore ?? null,
    score90d: score90d?.totalScore ?? null,
  })

  return {
    profile: {
      handle: traderId,
      id: traderId,
      bio: undefined,
      followers: arenaFollowers,
      avatar_url: avatarUrl,
      isRegistered: false,
      source: sourceType,
    },
    performance: buildPerformanceObj(snapshot, snapshot7d, snapshot30d, score90d, score30d, score7d, overallScore, null, null, null),
    stats: {
      additionalStats: {
        tradesCount: snapshot?.trades_count ?? undefined,
        activeSince: trackedSince
          ? new Date(trackedSince).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
          : undefined,
        maxDrawdown: snapshot?.max_drawdown ?? undefined,
      },
      trading: {
        totalTrades12M: snapshot?.trades_count ?? 0,
        avgProfit: 0,
        avgLoss: 0,
        profitableTradesPct: normalizeWinRate(snapshot?.win_rate ?? null) ?? 0,
      },
      frequentlyTraded: [],
    },
    assetBreakdown: { '90D': [], '30D': [], '7D': [] },
    equityCurve: { '90D': [], '30D': [], '7D': [] },
    portfolio: [],
    positionHistory: [],
    feed: [],
    similarTraders: [],
    trackedSince: trackedSince || undefined,
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

async function fetchSimilarTraders(
  supabase: SupabaseClient,
  sourceType: SourceType,
  traderId: string,
  traderHandle: string,
  snapshot: SnapshotData | null,
) {
  type SimilarTrader = { handle: string; id: string; followers: number; avatar_url?: string; source: string; roi_90d?: number; arena_score?: number }
  let similarTraders: SimilarTrader[] = []

  const processSimilarSnapshots = async (
    similarSnapshots: Array<{ source_trader_id: string; roi: unknown; arena_score: unknown; followers: unknown }> | null,
  ) => {
    if (!similarSnapshots || similarSnapshots.length === 0) return
    const dedupedSnapshots = [...new Map(similarSnapshots.map(s => [s.source_trader_id, s])).values()]
    const similarIds = dedupedSnapshots.map(s => s.source_trader_id)
    const { data: similarSources } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle, profile_url, avatar_url')
      .eq('source', sourceType)
      .in('source_trader_id', similarIds)

    if (similarSources) {
      const sourceMap = new Map(similarSources.map(s => [s.source_trader_id, s]))
      const seenHandles = new Set<string>()
      similarTraders = dedupedSnapshots
        .filter(snap => sourceMap.has(snap.source_trader_id))
        .map(snap => {
          const src = sourceMap.get(snap.source_trader_id)!
          return {
            handle: src.handle || snap.source_trader_id,
            id: snap.source_trader_id,
            followers: (snap.followers as number) ?? 0,
            avatar_url: src.avatar_url || undefined,
            source: sourceType,
            roi_90d: snap.roi != null ? parseFloat(snap.roi as string) : undefined,
            arena_score: snap.arena_score != null ? parseFloat(snap.arena_score as string) : undefined,
          }
        })
        .filter(t => {
          const h = t.handle.toLowerCase()
          if (h === traderHandle.toLowerCase()) return false
          if (seenHandles.has(h)) return false
          seenHandles.add(h)
          return true
        })
    }
  }

  if (snapshot?.arena_score != null) {
    const currentScore = typeof snapshot.arena_score === 'number' ? snapshot.arena_score : parseFloat(String(snapshot.arena_score))
    const scoreRange = Math.max(currentScore * 0.25, 10)
    const { data } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi, arena_score, followers')
      .eq('source', sourceType).eq('season_id', '90D')
      .neq('source_trader_id', traderId)
      .not('arena_score', 'is', null)
      .gte('arena_score', currentScore - scoreRange)
      .lte('arena_score', currentScore + scoreRange)
      .order('arena_score', { ascending: false }).limit(10)
    await processSimilarSnapshots(data)
  } else if (snapshot?.roi !== null && snapshot?.roi !== undefined) {
    const currentRoi = snapshot.roi
    const roiRange = Math.max(Math.abs(currentRoi) * 0.3, 20)
    const { data } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi, arena_score, followers')
      .eq('source', sourceType).eq('season_id', '90D')
      .neq('source_trader_id', traderId)
      .gte('roi', currentRoi - roiRange)
      .lte('roi', currentRoi + roiRange)
      .order('roi', { ascending: false }).limit(10)
    await processSimilarSnapshots(data)
  }

  return similarTraders
}

 
function buildPerformanceObj(
  snapshot: SnapshotData | null,
  snapshot7d: SnapshotData | null,
  snapshot30d: SnapshotData | null,
  score90d: ReturnType<typeof calculateArenaScore> | null,
  score30d: ReturnType<typeof calculateArenaScore> | null,
  score7d: ReturnType<typeof calculateArenaScore> | null,
  overallScore: number | null,
  statsDetail90d: StatsDetailData | null | undefined,
  statsDetail30d: StatsDetailData | null | undefined,
  statsDetail7d: StatsDetailData | null | undefined,
) {
  return {
    roi_90d: snapshot?.roi ?? 0,
    roi_7d: snapshot7d?.roi ?? undefined,
    roi_30d: snapshot30d?.roi ?? undefined,
    pnl: snapshot?.pnl ?? undefined,
    win_rate: normalizeWinRate(snapshot?.win_rate ?? null) ?? undefined,
    max_drawdown: snapshot?.max_drawdown ?? undefined,
    pnl_7d: snapshot7d?.pnl ?? undefined,
    pnl_30d: snapshot30d?.pnl ?? undefined,
    win_rate_7d: normalizeWinRate(snapshot7d?.win_rate ?? null) ?? undefined,
    win_rate_30d: normalizeWinRate(snapshot30d?.win_rate ?? null) ?? undefined,
    max_drawdown_7d: snapshot7d?.max_drawdown ?? undefined,
    max_drawdown_30d: snapshot30d?.max_drawdown ?? undefined,
    trades_count: snapshot?.trades_count ?? undefined,
    trades_count_7d: snapshot7d?.trades_count ?? undefined,
    trades_count_30d: snapshot30d?.trades_count ?? undefined,
    copiers_pnl: statsDetail90d?.copiers_pnl ?? undefined,
    copiers_pnl_7d: statsDetail7d?.copiers_pnl ?? undefined,
    copiers_pnl_30d: statsDetail30d?.copiers_pnl ?? undefined,
    avg_holding_time_hours: statsDetail90d?.avg_holding_time_hours ?? undefined,
    avg_holding_time_hours_7d: statsDetail7d?.avg_holding_time_hours ?? undefined,
    avg_holding_time_hours_30d: statsDetail30d?.avg_holding_time_hours ?? undefined,
    arena_score: score90d?.totalScore ?? undefined,
    arena_score_90d: score90d?.totalScore ?? undefined,
    arena_score_30d: score30d?.totalScore ?? undefined,
    arena_score_7d: score7d?.totalScore ?? undefined,
    overall_score: overallScore,
    return_score: score90d?.returnScore ?? undefined,
    pnl_score: score90d?.pnlScore ?? undefined,
    return_score_30d: score30d?.returnScore ?? undefined,
    pnl_score_30d: score30d?.pnlScore ?? undefined,
    return_score_7d: score7d?.returnScore ?? undefined,
    pnl_score_7d: score7d?.pnlScore ?? undefined,
    drawdown_score: score90d?.drawdownScore ?? undefined,
    drawdown_score_30d: score30d?.drawdownScore ?? undefined,
    drawdown_score_7d: score7d?.drawdownScore ?? undefined,
    stability_score: score90d?.stabilityScore ?? undefined,
    stability_score_30d: score30d?.stabilityScore ?? undefined,
    stability_score_7d: score7d?.stabilityScore ?? undefined,
    score_confidence: score90d?.scoreConfidence ?? undefined,
    sharpe_ratio: statsDetail90d?.sharpe_ratio ?? undefined,
    sharpe_ratio_30d: statsDetail30d?.sharpe_ratio ?? undefined,
    sharpe_ratio_7d: statsDetail7d?.sharpe_ratio ?? undefined,
    winning_positions: statsDetail90d?.winning_positions ?? undefined,
    winning_positions_30d: statsDetail30d?.winning_positions ?? undefined,
    winning_positions_7d: statsDetail7d?.winning_positions ?? undefined,
    total_positions: statsDetail90d?.total_positions ?? undefined,
    total_positions_30d: statsDetail30d?.total_positions ?? undefined,
    total_positions_7d: statsDetail7d?.total_positions ?? undefined,
  }
}

 
function buildTraderResponse(p: {
  traderHandle: string
  traderId: string
  sourceType: SourceType
  source: TraderSource
  snapshot: SnapshotData | null
  snapshot7d: SnapshotData | null
  snapshot30d: SnapshotData | null
  arenaFollowers: number
  userProfile: { id: string; bio: string } | null
  portfolioData: PortfolioItem[]
  positionHistoryData: PositionHistoryItem[]
  posts: Array<{ id: string; title?: string; content?: string; created_at: string; group_id?: string; like_count?: number; is_pinned?: boolean; groups?: { name?: string }[] }>
  assetBreakdown90d: AssetBreakdownItem[]
  assetBreakdown30d: AssetBreakdownItem[]
  assetBreakdown7d: AssetBreakdownItem[]
  equityCurve90d: EquityCurvePoint[]
  equityCurve30d: EquityCurvePoint[]
  equityCurve7d: EquityCurvePoint[]
  statsDetail90d: StatsDetailData | undefined
  statsDetail30d: StatsDetailData | undefined
  statsDetail7d: StatsDetailData | undefined
  trackedSince: string | null
  v3Scores: { profitability_score: number | null; risk_control_score: number | null; execution_score: number | null; arena_score_v3: number | null; score_completeness: string | null; score_penalty: number | null } | null
  similarTraders: Array<{ handle: string; id: string; followers: number; avatar_url?: string; source: string; roi_90d?: number; arena_score?: number }>
  score90d: ReturnType<typeof calculateArenaScore> | null
  score30d: ReturnType<typeof calculateArenaScore> | null
  score7d: ReturnType<typeof calculateArenaScore> | null
  overallScore: number | null
}) {
  const perf = buildPerformanceObj(
    p.snapshot, p.snapshot7d, p.snapshot30d,
    p.score90d, p.score30d, p.score7d, p.overallScore,
    p.statsDetail90d ?? null, p.statsDetail30d ?? null, p.statsDetail7d ?? null,
  )

  return {
    profile: {
      handle: p.traderHandle,
      id: p.traderId,
      bio: p.userProfile?.bio || undefined,
      followers: p.arenaFollowers,
      copiers: p.statsDetail90d?.copiers_count ?? undefined,
      avatar_url: p.source.avatar_url || undefined,
      cover_url: undefined,
      profile_url: p.source.profile_url || undefined,
      isRegistered: !!p.userProfile,
      source: p.sourceType,
      market_type: p.source.market_type || undefined,
    },
    performance: {
      ...perf,
      // V3 三维度分数
      profitability_score: p.v3Scores?.profitability_score ?? p.snapshot?.profitability_score ?? undefined,
      risk_control_score: p.v3Scores?.risk_control_score ?? p.snapshot?.risk_control_score ?? undefined,
      execution_score: p.v3Scores?.execution_score ?? p.snapshot?.execution_score ?? undefined,
      arena_score_v3: p.v3Scores?.arena_score_v3 ?? p.snapshot?.arena_score_v3 ?? undefined,
      score_completeness: p.v3Scores?.score_completeness ?? p.snapshot?.score_completeness ?? undefined,
      score_penalty: p.v3Scores?.score_penalty ?? p.snapshot?.score_penalty ?? undefined,
    },
    stats: {
      additionalStats: {
        tradesCount: p.snapshot?.trades_count ?? undefined,
        avgHoldingTime: p.statsDetail90d?.avg_holding_time_hours
          ? `${Math.round(p.statsDetail90d.avg_holding_time_hours)}h`
          : undefined,
        avgProfit: p.statsDetail90d?.avg_profit ?? undefined,
        avgLoss: p.statsDetail90d?.avg_loss ?? undefined,
        activeSince: p.trackedSince
          ? new Date(p.trackedSince).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
          : undefined,
        maxDrawdown: p.snapshot?.max_drawdown ?? undefined,
      },
      trading: {
        totalTrades12M: p.snapshot?.trades_count ?? 0,
        avgProfit: p.statsDetail90d?.avg_profit ?? 0,
        avgLoss: p.statsDetail90d?.avg_loss ?? 0,
        profitableTradesPct: normalizeWinRate(p.snapshot?.win_rate ?? null) ?? 0,
        winningPositions: p.statsDetail90d?.winning_positions ?? undefined,
        totalPositions: p.statsDetail90d?.total_positions ?? undefined,
      },
      frequentlyTraded: p.assetBreakdown90d.map(item => ({
        symbol: item.symbol,
        weightPct: item.weight_pct,
        count: 0,
        avgProfit: 0,
        avgLoss: 0,
        profitablePct: 0,
      })),
    },
    assetBreakdown: {
      '90D': p.assetBreakdown90d.map(item => ({ symbol: item.symbol, weightPct: item.weight_pct })),
      '30D': p.assetBreakdown30d.map(item => ({ symbol: item.symbol, weightPct: item.weight_pct })),
      '7D': p.assetBreakdown7d.map(item => ({ symbol: item.symbol, weightPct: item.weight_pct })),
    },
    equityCurve: {
      '90D': p.equityCurve90d.map(item => ({ date: item.data_date, roi: item.roi_pct ?? 0, pnl: item.pnl_usd ?? 0 })),
      '30D': p.equityCurve30d.map(item => ({ date: item.data_date, roi: item.roi_pct ?? 0, pnl: item.pnl_usd ?? 0 })),
      '7D': p.equityCurve7d.map(item => ({ date: item.data_date, roi: item.roi_pct ?? 0, pnl: item.pnl_usd ?? 0 })),
    },
    portfolio: p.portfolioData.map((item) => ({
      market: item.symbol || '',
      direction: item.direction === 'short' ? 'short' : 'long',
      invested: item.invested_pct ?? 0,
      pnl: item.pnl ?? 0,
      value: item.invested_pct ?? 0,
      price: item.entry_price ?? 0,
    })),
    positionHistory: p.positionHistoryData.map((item) => ({
      symbol: item.symbol || '',
      direction: item.direction === 'short' ? 'short' : 'long',
      positionType: item.position_type || 'perpetual',
      marginMode: item.margin_mode || 'cross',
      openTime: item.open_time || '',
      closeTime: item.close_time || '',
      entryPrice: item.entry_price || 0,
      exitPrice: item.exit_price || 0,
      maxPositionSize: item.max_position_size || 0,
      closedSize: item.closed_size || 0,
      pnlUsd: item.pnl_usd || 0,
      pnlPct: item.pnl_pct || 0,
      status: item.status || 'closed',
    })),
    feed: p.posts.map((post) => ({
      id: post.id,
      type: post.group_id ? 'group_post' : 'post',
      title: post.title,
      content: post.content || '',
      time: post.created_at,
      groupId: post.group_id,
      groupName: post.groups?.[0]?.name,
      like_count: post.like_count || 0,
      is_pinned: post.is_pinned || false,
    })),
    similarTraders: p.similarTraders,
    trackedSince: p.trackedSince || undefined,
  }
}

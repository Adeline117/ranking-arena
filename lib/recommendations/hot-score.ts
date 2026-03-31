/**
 * Hot Score Algorithm
 *
 * Computes a composite "hotness" score for each trader based on:
 * - ROI momentum (recent change rate)
 * - Follower growth rate
 * - Trading frequency
 * - Time decay (newer = hotter)
 *
 * No ML -- pure rule-based signal aggregation.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('hot-score')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface HotTrader {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  followers: number | null
  trades_count: number | null
  hot_score: number
  signals: HotSignals
}

export interface HotSignals {
  roiMomentum: number
  followerGrowth: number
  tradingFrequency: number
  recency: number
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WEIGHTS = {
  roiMomentum: 0.35,
  followerGrowth: 0.20,
  tradingFrequency: 0.15,
  recency: 0.30,
}

/** How many hours back to look for "recent" snapshots */
const LOOKBACK_HOURS = 48

// ---------------------------------------------------------------------------
// Supabase helper
// ---------------------------------------------------------------------------

function getSupabase() {
  return getSupabaseAdmin()
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

interface SnapshotRow {
  source: string
  source_trader_id: string
  roi: number | null
  followers: number | null
  trades_count: number | null
  captured_at: string
}

interface RankRow {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  followers: number | null
}

/**
 * Compute hot traders list, sorted by hot_score descending.
 */
export async function computeHotTraders(limit = 50): Promise<HotTrader[]> {
  const supabase = getSupabase()

  // 1. Fetch current leaderboard ranks (latest standings)
  const { data: ranks, error: ranksErr } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate, followers')
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(300)

  if (ranksErr || !ranks || ranks.length === 0) {
    logger.error('Failed to fetch leaderboard_ranks', { error: ranksErr })
    return []
  }

  const typedRanks = ranks as unknown as RankRow[]

  // 2. Fetch recent snapshots for momentum calculation
  // Use trader_snapshots_v2 (the active data pipeline table) instead of legacy trader_snapshots
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString()
  const traderIds = typedRanks.map(r => r.source_trader_id)

  // Fetch in batches to avoid oversized IN clause
  const batchSize = 100
  const allSnapshots: SnapshotRow[] = []

  for (let i = 0; i < traderIds.length; i += batchSize) {
    const batch = traderIds.slice(i, i + batchSize)
    const { data: snaps } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key, roi_pct, followers, trades_count, created_at')
      .in('trader_key', batch)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true })

    if (snaps) {
      // Map v2 fields to SnapshotRow shape
      allSnapshots.push(...(snaps as unknown as Array<Record<string, unknown>>).map(s => ({
        source: String(s.platform || ''),
        source_trader_id: String(s.trader_key || ''),
        roi: s.roi_pct != null ? Number(s.roi_pct) : null,
        followers: s.followers != null ? Number(s.followers) : null,
        trades_count: s.trades_count != null ? Number(s.trades_count) : null,
        captured_at: String(s.created_at || ''),
      })))
    }
  }

  // Group snapshots by trader key
  const snapshotMap = new Map<string, SnapshotRow[]>()
  for (const snap of allSnapshots) {
    const key = `${snap.source}:${snap.source_trader_id}`
    const arr = snapshotMap.get(key) || []
    arr.push(snap)
    snapshotMap.set(key, arr)
  }

  // 3. Score each trader
  const now = Date.now()
  const scored: HotTrader[] = []

  for (const rank of typedRanks) {
    const key = `${rank.source}:${rank.source_trader_id}`
    const snapshots = snapshotMap.get(key) || []

    const signals = computeSignals(snapshots, rank, now)
    const hot_score =
      WEIGHTS.roiMomentum * signals.roiMomentum +
      WEIGHTS.followerGrowth * signals.followerGrowth +
      WEIGHTS.tradingFrequency * signals.tradingFrequency +
      WEIGHTS.recency * signals.recency

    scored.push({
      source: rank.source,
      source_trader_id: rank.source_trader_id,
      handle: rank.handle,
      avatar_url: rank.avatar_url,
      arena_score: rank.arena_score,
      roi: rank.roi,
      pnl: rank.pnl,
      win_rate: rank.win_rate,
      followers: rank.followers,
      trades_count: snapshots.length > 0 ? snapshots[snapshots.length - 1].trades_count : null,
      hot_score: Math.round(hot_score * 1000) / 1000,
      signals,
    })
  }

  scored.sort((a, b) => b.hot_score - a.hot_score)
  return scored.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Signal computation helpers
// ---------------------------------------------------------------------------

function computeSignals(
  snapshots: SnapshotRow[],
  rank: RankRow,
  now: number,
): HotSignals {
  // -- ROI Momentum --
  let roiMomentum = 0
  if (snapshots.length >= 2) {
    const oldest = snapshots[0]
    const newest = snapshots[snapshots.length - 1]
    const oldRoi = oldest.roi ?? 0
    const newRoi = newest.roi ?? 0
    // Percentage-point change, clamped
    const diff = newRoi - oldRoi
    // Normalize: 10pp change = score 1.0
    roiMomentum = clamp(diff / 10, -1, 1)
  } else if (rank.roi !== null && rank.roi > 0) {
    // No historical data -- small positive signal from current positive ROI
    roiMomentum = clamp(rank.roi / 100, 0, 0.3)
  }

  // -- Follower Growth --
  let followerGrowth = 0
  if (snapshots.length >= 2) {
    const oldFollowers = snapshots[0].followers ?? 0
    const newFollowers = snapshots[snapshots.length - 1].followers ?? 0
    if (oldFollowers > 0) {
      const growthRate = (newFollowers - oldFollowers) / oldFollowers
      // 10% growth = score 1.0
      followerGrowth = clamp(growthRate / 0.1, -1, 1)
    } else if (newFollowers > 0) {
      followerGrowth = 0.5
    }
  }

  // -- Trading Frequency --
  // More snapshots with trades_count changes = more active
  let tradingFrequency = 0
  if (snapshots.length >= 2) {
    let tradeChanges = 0
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1].trades_count ?? 0
      const curr = snapshots[i].trades_count ?? 0
      if (curr > prev) tradeChanges++
    }
    // Normalize: active in half the intervals = score 1.0
    tradingFrequency = clamp(tradeChanges / Math.max(1, (snapshots.length - 1) * 0.5), 0, 1)
  }

  // -- Recency (time decay) --
  let recency = 0.5 // default if no snapshot data
  if (snapshots.length > 0) {
    const latestTime = new Date(snapshots[snapshots.length - 1].captured_at).getTime()
    const hoursAgo = (now - latestTime) / (3600 * 1000)
    // Exponential decay: half-life = 12 hours
    recency = Math.exp(-0.693 * hoursAgo / 12)
  }

  return {
    roiMomentum: round3(roiMomentum),
    followerGrowth: round3(followerGrowth),
    tradingFrequency: round3(tradingFrequency),
    recency: round3(recency),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

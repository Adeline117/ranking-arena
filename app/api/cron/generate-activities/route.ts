/**
 * Activity Generation Cron Job
 *
 * Compares consecutive trader_snapshots to detect changes and emits
 * auto-generated activity events into the trader_activities table.
 *
 * Detected event types:
 *   rank_up         - rank improved significantly (>= 5 positions or entered top 10)
 *   roi_milestone   - ROI crossed a predefined threshold (100%, 200%, 500%)
 *   score_high      - arena_score_v3 is the highest ever recorded for this trader
 *   win_streak      - max_consecutive_wins >= 5
 *   entered_top10   - rank moved from > 10 to <= 10
 *   large_profit    - pnl increased by >= 50 000 USD in one snapshot window
 *
 * Schedule: every 30 minutes (via vercel.json cron config)
 *
 * @module app/api/cron/generate-activities
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 120

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function verifyCronSecret(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return process.env.NODE_ENV === 'development'
  }
  return authHeader === `Bearer ${cronSecret}`
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase credentials')
  return createClient(url, key)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SnapshotRow {
  source: string
  source_trader_id: string
  rank: number | null
  roi: number | null
  pnl: number | null
  arena_score_v3: number | null
  max_consecutive_wins: number | null
  captured_at: string
  handle: string | null
  avatar_url: string | null
}

interface ActivityInsert {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  activity_type: string
  activity_text: string
  metric_value: number | null
  metric_label: string | null
  dedup_key: string
  occurred_at: string
}

// ---------------------------------------------------------------------------
// ROI milestone thresholds (percent)
// ---------------------------------------------------------------------------
const ROI_MILESTONES = [50, 100, 200, 500, 1000]

// ---------------------------------------------------------------------------
// Core detection logic
// ---------------------------------------------------------------------------

/**
 * Compare two consecutive snapshots for the same trader and return any
 * activity events that should be created.
 */
function detectActivities(
  latest: SnapshotRow,
  prev: SnapshotRow | null,
  histMaxScore: number | null,
): ActivityInsert[] {
  const results: ActivityInsert[] = []
  const source = latest.source
  const traderId = latest.source_trader_id
  const handle = latest.handle ?? traderId
  const avatar = latest.avatar_url
  const occurredAt = latest.captured_at

  // Helper to build a base event
  function makeActivity(
    type: string,
    text: string,
    dedupKey: string,
    metricValue: number | null = null,
    metricLabel: string | null = null,
  ): ActivityInsert {
    return {
      source,
      source_trader_id: traderId,
      handle,
      avatar_url: avatar,
      activity_type: type,
      activity_text: text,
      metric_value: metricValue,
      metric_label: metricLabel,
      dedup_key: dedupKey,
      occurred_at: occurredAt,
    }
  }

  // Date prefix for daily dedup (prevents re-firing the same event on every cron run)
  const datePrefix = occurredAt.slice(0, 10) // YYYY-MM-DD

  // ------------------------------------------------------------------
  // 1. Rank improvements
  // ------------------------------------------------------------------
  const newRank = latest.rank
  const oldRank = prev?.rank ?? null

  if (newRank !== null && newRank > 0) {
    // Entered top 10
    if (newRank <= 10 && (oldRank === null || oldRank > 10)) {
      results.push(
        makeActivity(
          'entered_top10',
          `${handle} entered the Top 10 on ${source} (rank #${newRank})`,
          `entered_top10:${source}:${traderId}:${datePrefix}`,
          newRank,
          'Rank',
        ),
      )
    }

    // Rank improved by 5+ positions (avoid double-firing with entered_top10)
    if (
      oldRank !== null &&
      oldRank > 10 &&
      newRank > 10 &&
      oldRank - newRank >= 5
    ) {
      results.push(
        makeActivity(
          'rank_up',
          `${handle} climbed from #${oldRank} to #${newRank} on ${source}`,
          `rank_up:${source}:${traderId}:${datePrefix}:${oldRank}:${newRank}`,
          newRank,
          'Rank',
        ),
      )
    }
  }

  // ------------------------------------------------------------------
  // 2. ROI milestones
  // ------------------------------------------------------------------
  const newRoi = latest.roi
  const oldRoi = prev?.roi ?? null

  if (newRoi !== null) {
    for (const milestone of ROI_MILESTONES) {
      if (
        newRoi >= milestone &&
        (oldRoi === null || oldRoi < milestone)
      ) {
        results.push(
          makeActivity(
            'roi_milestone',
            `${handle}'s 7D ROI surpassed ${milestone}% on ${source}`,
            `roi_milestone:${source}:${traderId}:${milestone}`,
            milestone,
            'ROI %',
          ),
        )
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. Arena Score new high
  // ------------------------------------------------------------------
  const newScore = latest.arena_score_v3

  if (newScore !== null) {
    // histMaxScore is the highest score ever seen BEFORE this snapshot
    if (histMaxScore === null || newScore > histMaxScore) {
      results.push(
        makeActivity(
          'score_high',
          `${handle} reached a new Arena Score high of ${newScore.toFixed(1)} on ${source}`,
          `score_high:${source}:${traderId}:${datePrefix}`,
          newScore,
          'Arena Score',
        ),
      )
    }
  }

  // ------------------------------------------------------------------
  // 4. Win streak >= 5
  // ------------------------------------------------------------------
  const wins = latest.max_consecutive_wins
  const prevWins = prev?.max_consecutive_wins ?? null

  if (wins !== null && wins >= 5) {
    // Only fire when the streak count increases to avoid repeat events
    if (prevWins === null || wins > prevWins) {
      results.push(
        makeActivity(
          'win_streak',
          `${handle} is on a ${wins}-trade winning streak on ${source}`,
          `win_streak:${source}:${traderId}:${wins}`,
          wins,
          'Wins',
        ),
      )
    }
  }

  // ------------------------------------------------------------------
  // 5. Large profit (PnL delta >= 50 000 USD in one snapshot interval)
  // ------------------------------------------------------------------
  const newPnl = latest.pnl
  const oldPnl = prev?.pnl ?? null

  if (newPnl !== null && oldPnl !== null) {
    const delta = newPnl - oldPnl
    if (delta >= 50000) {
      const bucket = Math.floor(delta / 50000) * 50000 // nearest $50K bucket for dedup
      results.push(
        makeActivity(
          'large_profit',
          `${handle} gained $${(delta / 1000).toFixed(0)}K in a single window on ${source}`,
          `large_profit:${source}:${traderId}:${datePrefix}:${bucket}`,
          delta,
          'PnL USD',
        ),
      )
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()

  try {
    const supabase = getClient()

    // ------------------------------------------------------------------
    // Step 1: Fetch the 2 most recent snapshots per trader from the last
    //         72 h to limit the scan window.
    // ------------------------------------------------------------------
    const windowStart = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()

    const { data: rawSnapshots, error: snapError } = await supabase
      .from('trader_snapshots')
      .select(`
        source,
        source_trader_id,
        rank,
        roi,
        pnl,
        arena_score_v3,
        max_consecutive_wins,
        captured_at
      `)
      .gte('captured_at', windowStart)
      .order('captured_at', { ascending: false })
      .limit(10000)

    if (snapError) {
      logger.error('generate-activities: failed to fetch snapshots', snapError)
      return NextResponse.json({ error: snapError.message }, { status: 500 })
    }

    if (!rawSnapshots || rawSnapshots.length === 0) {
      return NextResponse.json({ ok: true, message: 'No snapshots in window', generated: 0 })
    }

    // ------------------------------------------------------------------
    // Step 2: Enrich with trader metadata (handle, avatar)
    // ------------------------------------------------------------------
    const uniqueKeys = [...new Set(rawSnapshots.map((s) => `${s.source}:${s.source_trader_id}`))]
    const sourceTraderIds = [...new Set(rawSnapshots.map((s) => s.source_trader_id))]

    const { data: sourceRows } = await supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle, avatar_url')
      .in('source_trader_id', sourceTraderIds)

    const metaMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
    for (const row of sourceRows ?? []) {
      metaMap.set(`${row.source}:${row.source_trader_id}`, {
        handle: row.handle,
        avatar_url: row.avatar_url,
      })
    }

    // ------------------------------------------------------------------
    // Step 3: Group snapshots by trader and keep the 2 most recent
    // ------------------------------------------------------------------
    const traderSnapMap = new Map<string, SnapshotRow[]>()

    for (const snap of rawSnapshots) {
      const key = `${snap.source}:${snap.source_trader_id}`
      const meta = metaMap.get(key) ?? { handle: null, avatar_url: null }

      const enriched: SnapshotRow = {
        source: snap.source,
        source_trader_id: snap.source_trader_id,
        rank: snap.rank,
        roi: snap.roi !== null ? Number(snap.roi) : null,
        pnl: snap.pnl !== null ? Number(snap.pnl) : null,
        arena_score_v3: snap.arena_score_v3 !== null ? Number(snap.arena_score_v3) : null,
        max_consecutive_wins: snap.max_consecutive_wins,
        captured_at: snap.captured_at,
        handle: meta.handle,
        avatar_url: meta.avatar_url,
      }

      const existing = traderSnapMap.get(key) ?? []
      if (existing.length < 2) {
        existing.push(enriched)
        traderSnapMap.set(key, existing)
      }
    }

    // ------------------------------------------------------------------
    // Step 4: Fetch historical max arena_score_v3 per trader for "score_high"
    // ------------------------------------------------------------------
    const histScoreMap = new Map<string, number>()

    const { data: histScores } = await supabase.rpc
      ? await supabase
          .from('trader_snapshots')
          .select('source, source_trader_id, arena_score_v3')
          .not('arena_score_v3', 'is', null)
          .lt('captured_at', windowStart) // only before our window
          .order('arena_score_v3', { ascending: false })
          .limit(5000)
      : { data: null }

    for (const row of histScores ?? []) {
      const key = `${row.source}:${row.source_trader_id}`
      const existing = histScoreMap.get(key)
      const val = Number(row.arena_score_v3)
      if (existing === undefined || val > existing) {
        histScoreMap.set(key, val)
      }
    }

    // ------------------------------------------------------------------
    // Step 5: Detect activities
    // ------------------------------------------------------------------
    const toInsert: ActivityInsert[] = []

    for (const [, snaps] of traderSnapMap) {
      const latest = snaps[0]  // most recent
      const prev = snaps[1] ?? null   // previous (or null for new traders)
      const key = `${latest.source}:${latest.source_trader_id}`
      const histMax = histScoreMap.get(key) ?? null

      const events = detectActivities(latest, prev, histMax)
      toInsert.push(...events)
    }

    if (toInsert.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No new activities detected',
        generated: 0,
        durationMs: Date.now() - startTime,
      })
    }

    // ------------------------------------------------------------------
    // Step 6: Upsert activities (ON CONFLICT DO NOTHING via dedup_key)
    // ------------------------------------------------------------------
    const BATCH_SIZE = 100
    let inserted = 0

    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE)
      const { error: insertError, count } = await supabase
        .from('trader_activities')
        .upsert(batch, { onConflict: 'dedup_key', ignoreDuplicates: true })
        .select('id')

      if (insertError) {
        logger.error('generate-activities: insert error', insertError)
      } else {
        inserted += count ?? batch.length
      }
    }

    logger.info(`generate-activities: inserted ${inserted} of ${toInsert.length} potential events`)

    return NextResponse.json({
      ok: true,
      tradersScanned: uniqueKeys.length,
      potentialEvents: toInsert.length,
      inserted,
      durationMs: Date.now() - startTime,
    })
  } catch (err) {
    logger.error('generate-activities: unhandled error', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

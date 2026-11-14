/**
 * Top Traders API for sidebar widget
 * Cached via Redis to avoid direct Supabase calls from client
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { getOrSetWithLock } from '@/lib/cache'
import {
  isPublicRankingSourceAllowed,
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  publicRankingCacheKey,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

export const runtime = 'edge'

const SIDEBAR_PERIOD = '90D'
const PUBLIC_RANKED_SIDEBAR_COLUMNS =
  'source,source_trader_id,handle,avatar_url,roi,pnl,arena_score,rank,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'

interface SidebarPublicRankedRow extends Record<string, unknown> {
  source: string
  source_trader_id: string
  rank: number
  arena_score: number
  roi: number
}

interface SidebarCacheValue {
  period: typeof SIDEBAR_PERIOD
  rows: unknown[]
}

interface SanitizedSidebarCohort {
  rows: SidebarPublicRankedRow[]
  integrityCompromised: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSidebarPublicRankedRow(row: unknown): row is SidebarPublicRankedRow {
  return (
    isRecord(row) &&
    typeof row.source === 'string' &&
    isPublicRankingSourceAllowed(row.source) &&
    typeof row.source_trader_id === 'string' &&
    row.source_trader_id.length > 0 &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0 &&
    typeof row.arena_score === 'number' &&
    Number.isFinite(row.arena_score) &&
    typeof row.roi === 'number' &&
    Number.isFinite(row.roi)
  )
}

function sanitizeSidebarCohort(value: unknown): SanitizedSidebarCohort {
  const envelope = isRecord(value) ? value : null
  const hasValidEnvelope = envelope?.period === SIDEBAR_PERIOD && Array.isArray(envelope?.rows)
  const rawRows: unknown[] = hasValidEnvelope && Array.isArray(envelope?.rows) ? envelope.rows : []
  const sanitized = sanitizePublicRankingPayload(
    { traders: rawRows, period: SIDEBAR_PERIOD },
    { expectedPeriod: SIDEBAR_PERIOD }
  ) as { traders?: unknown[] }
  const rows = Array.isArray(sanitized.traders)
    ? sanitized.traders.filter(isSidebarPublicRankedRow)
    : []

  return {
    rows,
    // Do not turn a malformed cached object or a filtered page into a shorter
    // leaderboard. The view makes this impossible for fresh reads; a mismatch
    // is cache/schema drift and must fail closed.
    integrityCompromised: !hasValidEnvelope || rows.length !== rawRows.length,
  }
}

function partialSidebarResponse() {
  return {
    traders: [],
    ranking_visibility: 'partial',
    ranking_visibility_reason: 'public_cohort_unverified',
    ranking_visibility_reasons: ['public_cohort_unverified'],
  }
}

export const GET = withPublic(
  async ({ supabase }) => {
    const cached = await getOrSetWithLock<SidebarCacheValue>(
      // v3 retains complete view rows, so cache hits can re-run the same
      // proof checks as fresh reads. Never reuse the former projected payload.
      publicRankingCacheKey('sidebar:top-traders:v3'),
      async () => {
        // Fetch top 50 to diversify across exchanges (avoid showing only 1-2 exchanges)
        // The security-barrier view establishes row eligibility before every
        // request-derived predicate, ordering clause, or finite limit below.
        const { data: snapData, error: snapErr } = await supabase
          .from('public_ranked_leaderboard')
          .select(PUBLIC_RANKED_SIDEBAR_COLUMNS)
          .eq('season_id', SIDEBAR_PERIOD)
          .not('rank', 'is', null)
          .not('arena_score', 'is', null)
          .gt('arena_score', 50)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('arena_score', { ascending: false, nullsFirst: false })
          .order('rank', { ascending: true, nullsFirst: false })
          .limit(50)

        if (snapErr) {
          throw snapErr
        }
        return { period: SIDEBAR_PERIOD, rows: Array.isArray(snapData) ? snapData : [] }
      },
      {
        ttl: 300,
        lockTtl: 10,
        tags: [PUBLIC_RANKING_REDIS_TAG, `season:${SIDEBAR_PERIOD}`],
        skipMemory: true,
        writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
      }
    )

    const cohort = sanitizeSidebarCohort(cached)
    if (cohort.integrityCompromised) {
      const response = NextResponse.json(partialSidebarResponse())
      response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate')
      return response
    }

    // Diversify only after the complete proof-bearing cohort has been
    // established. The fields used here are verified finite values; do not
    // substitute null with zero for ordering or display.
    const perExchange = new Map<string, SidebarPublicRankedRow>()
    const rest: SidebarPublicRankedRow[] = []
    for (const row of cohort.rows) {
      if (!perExchange.has(row.source)) {
        perExchange.set(row.source, row)
      } else {
        rest.push(row)
      }
    }
    const diverse = [...perExchange.values()].sort(
      (left, right) => right.arena_score - left.arena_score || left.rank - right.rank
    )
    const data = {
      traders: [...diverse, ...rest].slice(0, 10).map((row) => ({
        source: row.source,
        source_trader_id: row.source_trader_id,
        handle: typeof row.handle === 'string' && row.handle.length > 0 ? row.handle : null,
        avatar_url:
          typeof row.avatar_url === 'string' && row.avatar_url.length > 0 ? row.avatar_url : null,
        roi: row.roi,
        arena_score: row.arena_score,
        rank: row.rank,
      })),
    }

    const response = NextResponse.json(data)
    response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate')
    return response
  },
  { name: 'sidebar-top-traders', rateLimit: 'read' }
)

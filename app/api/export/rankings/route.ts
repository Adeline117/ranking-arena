/**
 * Server-side export of verified public ranking rows (CSV / JSON).
 *
 * GET /api/export/rankings?format=csv|json&exchange=<canonical-source>&timeRange=90D&limit=500
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyEdgeCronSecret } from '@/lib/auth/edge-cron-auth'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { sanitizePublicRankingPayload } from '@/lib/rankings/publication-policy'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const EXPORT_QUERY_KEYS = new Set(['format', 'exchange', 'timeRange', 'limit'])
const PUBLIC_RANKED_EXPORT_COLUMNS =
  'rank,source_trader_id,handle,source,arena_score,roi,pnl,win_rate,max_drawdown,followers,trades_count,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'

const exportSchema = z.object({
  format: z.enum(['csv', 'json']).optional().default('csv'),
  // `all` is an explicit no-filter compatibility value. Any other source is
  // bound to the canonical public-source token grammar before it reaches SQL.
  exchange: z
    .string()
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
    .max(128)
    .optional(),
  timeRange: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.toUpperCase() : value),
      z.enum(['7D', '30D', '90D'])
    )
    .optional()
    .default('90D'),
  limit: z.coerce.number().int().min(1).max(2_000).optional().default(500),
})

type PublicRankedExportQueryResult = {
  data: unknown[] | null
  error: { message: string } | null
}

type PublicRankedExportQuery = PromiseLike<PublicRankedExportQueryResult> & {
  select(columns: string): PublicRankedExportQuery
  eq(column: string, value: string): PublicRankedExportQuery
  not(column: string, operator: string, value: null): PublicRankedExportQuery
  order(
    column: string,
    options: { ascending: boolean; nullsFirst: boolean }
  ): PublicRankedExportQuery
  limit(count: number): PublicRankedExportQuery
}

type PublicRankedExportClient = {
  from(relation: 'public_ranked_leaderboard'): PublicRankedExportQuery
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicRankedExportClient(value: unknown): PublicRankedExportClient {
  if (!isRecord(value) || typeof value.from !== 'function') {
    throw new TypeError('Supabase client does not expose the public ranking cohort')
  }
  return value as PublicRankedExportClient
}

function escapeCsv(value: unknown): string {
  if (value == null) return ''
  const stringValue = String(value)
  return /[,"\n\r]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function hasPositiveRank(row: unknown): row is Record<string, unknown> {
  return (
    isRecord(row) && typeof row.rank === 'number' && Number.isSafeInteger(row.rank) && row.rank > 0
  )
}

function exportRow(row: Record<string, unknown>) {
  return {
    rank: row.rank,
    trader_id: stringOrNull(row.source_trader_id),
    handle: stringOrNull(row.handle),
    source: stringOrNull(row.source),
    arena_score: finiteOrNull(row.arena_score),
    roi: finiteOrNull(row.roi),
    pnl: finiteOrNull(row.pnl),
    win_rate: finiteOrNull(row.win_rate),
    max_drawdown: finiteOrNull(row.max_drawdown),
    followers: finiteOrNull(row.followers),
    trades_count: finiteOrNull(row.trades_count),
  }
}

function invalidParameters(searchParams: URLSearchParams): boolean {
  for (const key of searchParams.keys()) {
    if (!EXPORT_QUERY_KEYS.has(key) || searchParams.getAll(key).length !== 1) return true
  }
  return false
}

export async function GET(request: NextRequest) {
  const rateLimited = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimited) return rateLimited
  if (!(await verifyEdgeCronSecret(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  if (invalidParameters(url.searchParams)) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 })
  }
  const parsed = exportSchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid parameters', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { format, limit, timeRange } = parsed.data
  const exchange = parsed.data.exchange === 'all' ? undefined : parsed.data.exchange
  try {
    let query = publicRankedExportClient(getSupabaseAdmin())
      .from('public_ranked_leaderboard')
      .select(PUBLIC_RANKED_EXPORT_COLUMNS)
      .eq('season_id', timeRange)
      .not('rank', 'is', null)

    if (exchange) query = query.eq('source', exchange)
    const { data, error } = await query
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(limit)

    if (error) {
      logger.error('[export/rankings] public cohort query failed:', error.message)
      return NextResponse.json({ error: 'Failed to fetch rankings' }, { status: 500 })
    }

    const rawRows = Array.isArray(data) ? data : []
    const sanitized = sanitizePublicRankingPayload(
      { traders: rawRows, period: timeRange },
      { expectedPeriod: timeRange }
    ) as { traders?: unknown[] }
    const safeRows = Array.isArray(sanitized.traders)
      ? sanitized.traders.filter(hasPositiveRank)
      : ([] as Record<string, unknown>[])

    // Exporting a later safe row after an ineligible row would lie about this
    // finite rank slice. A correct security-barrier view makes this impossible;
    // any deviation is a complete export proof failure.
    if (safeRows.length !== rawRows.length) {
      return NextResponse.json(
        { error: 'Public ranking evidence unavailable', code: 'PUBLIC_COHORT_UNVERIFIED' },
        { status: 409 }
      )
    }

    const rows = safeRows.map(exportRow)
    const fileScope = exchange || 'all'
    if (format === 'json') {
      return new Response(JSON.stringify(rows, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="rankings-${timeRange}-${fileScope}.json"`,
          'Cache-Control': 'no-store',
        },
      })
    }

    const headers = [
      'rank',
      'trader_id',
      'handle',
      'source',
      'arena_score',
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'followers',
      'trades_count',
    ] as const
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(',')),
    ].join('\n')

    return new Response('\uFEFF' + csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rankings-${timeRange}-${fileScope}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    logger.error('[export/rankings] Error:', error)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}

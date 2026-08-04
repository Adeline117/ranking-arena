/**
 * GET /api/admin/monitoring/arena-pipeline
 *
 * Arena ingest pipeline observability (new pipeline, ARENA_DATA_SPEC v1.2).
 * One row per (active arena.sources row × timeframe):
 * - latest PASSED snapshot timestamp + actual_count (publish-gate health)
 * - staging_rejects count over the last 24h
 * - serving_mode / phase (cutover state)
 *
 * Reads via the service_role-only RPC public.arena_pipeline_panel()
 * (migration 20260611214749) — functions are private-by-default, so this
 * data is reachable ONLY through this admin-authenticated route.
 *
 * Used by the /admin/monitoring arena pipeline panel.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import type { Database } from '@/lib/supabase/database.types'

const logger = createLogger('monitoring-arena-pipeline')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export interface ArenaPipelineRow {
  slug: string
  serving_mode: 'legacy' | 'shadow' | 'serving'
  status: string
  phase: number
  timeframe: number
  last_passed_at: string | null
  actual_count: number | null
  rejects_24h: number
}

type ArenaPipelineRpcRow =
  Database['public']['Functions']['arena_pipeline_panel']['Returns'][number]

function isServingMode(value: string): value is ArenaPipelineRow['serving_mode'] {
  return value === 'legacy' || value === 'shadow' || value === 'serving'
}

function toArenaPipelineRow(row: ArenaPipelineRpcRow): ArenaPipelineRow {
  if (!isServingMode(row.serving_mode)) {
    throw new Error(`arena_pipeline_panel returned invalid serving mode: ${row.serving_mode}`)
  }
  return {
    slug: row.slug,
    serving_mode: row.serving_mode,
    status: row.status,
    phase: row.phase,
    timeframe: row.timeframe,
    last_passed_at: row.last_passed_at,
    actual_count: row.actual_count,
    rejects_24h: row.rejects_24h,
  }
}

export async function GET(req: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.sensitive)
    if (rateLimitResponse) {
      logger.warn('Rate limit exceeded for monitoring/arena-pipeline')
      return rateLimitResponse
    }

    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data, error } = await supabase.rpc('arena_pipeline_panel')
    if (error) {
      logger.error('arena_pipeline_panel RPC failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to load pipeline data' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      rows: (data ?? []).map(toArenaPipelineRow),
    })
  } catch (error) {
    logger.error('arena-pipeline monitoring error', { error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

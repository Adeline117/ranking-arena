/**
 * GET /api/admin/monitoring/backfill
 *
 * Series-backfill progress observability (P1线 2026-07-09): per-source
 * series_backfill cursor position vs configured topn, plus the latest
 * metric fill-rate snapshot per (slug, metric) from arena.metric_fill_trend
 * (written daily by the fill-rate sentinel — zero new collection).
 *
 * Reads via the service_role-only RPC public.arena_backfill_panel()
 * (migration 20260709223039); reachable ONLY through this admin route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('monitoring-backfill')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export interface BackfillCursorRow {
  slug: string
  cursor: number | null
  topn: number | null
  updated_at: string | null
}
export interface BackfillFillRow {
  slug: string
  metric: string
  filled: number
  total: number
  taken_on: string
}

export async function GET(req: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.sensitive)
    if (rateLimitResponse) return rateLimitResponse

    const supabase = getSupabaseAdmin()
    const admin = await verifyAdmin(supabase, req.headers.get('authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data, error } = await supabase.rpc('arena_backfill_panel')
    if (error) {
      logger.error('arena_backfill_panel RPC failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to load backfill data' }, { status: 500 })
    }
    const payload = (data ?? { cursors: [], fill: [] }) as unknown as {
      cursors: BackfillCursorRow[]
      fill: BackfillFillRow[]
    }
    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), ...payload })
  } catch (error) {
    logger.error('backfill monitoring error', { error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

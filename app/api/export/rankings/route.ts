/**
 * Server-side export of full ranking data (CSV / JSON).
 * GET /api/export/rankings?format=csv|json&exchange=all&timeRange=90D&limit=500
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

function escapeCsv(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(request: NextRequest) {
  const rl = await checkRateLimit(request, RateLimitPresets.public)
  if (rl) return rl
  // Require authentication to prevent data scraping
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const url = new URL(request.url)
    const format = url.searchParams.get('format') || 'csv'
    const exchange = url.searchParams.get('exchange') || ''
    const limitParam = Number(url.searchParams.get('limit') || '500')
    const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 500, 2000)

    if (!['csv', 'json'].includes(format)) {
      return NextResponse.json({ error: 'Invalid format. Use csv or json.' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    let query = supabase
      .from('leaderboard_ranks')
      .select('rank, trader_id, handle, source, arena_score, roi, pnl, win_rate, max_drawdown, followers, trades_count')
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('rank', { ascending: true })
      .limit(limit)

    if (exchange && exchange !== 'all') {
      query = query.eq('source', exchange)
    }

    const { data, error } = await query

    if (error) {
      logger.error('[export/rankings] Supabase error:', error.message)
      return NextResponse.json({ error: 'Failed to fetch rankings' }, { status: 500 })
    }

    const rows = data || []

  if (format === 'json') {
    return new Response(JSON.stringify(rows, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="rankings-${exchange || 'all'}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // CSV
  const headers = ['rank', 'trader_id', 'handle', 'source', 'arena_score', 'roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'trades_count']
  const csvHeader = headers.join(',')
  const csvRows = rows.map(row =>
    headers.map(h => escapeCsv((row as Record<string, unknown>)[h])).join(',')
  )
  const csv = [csvHeader, ...csvRows].join('\n')

  return new Response('\uFEFF' + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rankings-${exchange || 'all'}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
  } catch (error) {
    logger.error('[export/rankings] Error:', error)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}

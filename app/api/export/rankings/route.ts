/**
 * Server-side export of full ranking data (CSV / JSON).
 * GET /api/export/rankings?format=csv|json&exchange=all&timeRange=90D&limit=500
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

function escapeCsv(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const format = url.searchParams.get('format') || 'csv'
    const exchange = url.searchParams.get('exchange') || ''
    const limitParam = Number(url.searchParams.get('limit') || '500')
    const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 500, 2000)

    if (!['csv', 'json'].includes(format)) {
      return NextResponse.json({ error: 'Invalid format. Use csv or json.' }, { status: 400 })
    }

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    let query = supabase
      .from('leaderboard_ranks')
      .select('rank, trader_id, handle, source, arena_score, roi, pnl, win_rate, max_drawdown, followers, trades_count')
      .order('rank', { ascending: true })
      .limit(limit)

    if (exchange && exchange !== 'all') {
      query = query.eq('source', exchange)
    }

    const { data, error } = await query

    if (error) {
      console.error('[export/rankings] Supabase error:', error.message)
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
    console.error('[export/rankings] Error:', error)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}

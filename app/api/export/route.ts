/**
 * 导出 API
 * GET /api/export - 导出交易员数据
 * 支持 CSV 和 JSON 格式
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getAuthUser } from '@/lib/api'
import { checkRateLimit } from '@/lib/utils/rate-limit'

export const runtime = 'nodejs'

type ExportFormat = 'csv' | 'json'
type ExportType = 'traders' | 'snapshots'

export async function GET(request: NextRequest) {
  try {
    // Rate limiting - stricter for export
    const rateLimitResponse = await checkRateLimit(request, { window: 60, requests: 10 })
    if (rateLimitResponse) return rateLimitResponse
    const { searchParams } = new URL(request.url)
    const format = (searchParams.get('format') || 'csv') as ExportFormat
    const type = (searchParams.get('type') || 'traders') as ExportType
    const source = searchParams.get('source') || 'all'
    const limit = Math.min(Number(searchParams.get('limit')) || 100, 1000)
    const period = searchParams.get('period') || '90D'

    const supabase = getSupabaseAdmin()

    // 可选：检查用户是否登录（如果需要限制导出功能）
    const user = await getAuthUser(request)
    const isLoggedIn = !!user

    // 未登录用户限制导出数量
    const actualLimit = isLoggedIn ? limit : Math.min(limit, 50)

    let data: Record<string, unknown>[] = []

    if (type === 'traders') {
      // 获取最新快照时间
      let query = supabase
        .from('trader_snapshots')
        .select('captured_at')
        .order('captured_at', { ascending: false })
        .limit(1)

      if (source !== 'all') {
        query = query.eq('source', source)
      }

      const { data: latestSnapshot } = await query.maybeSingle()

      if (latestSnapshot) {
        // 获取交易员数据
        let tradersQuery = supabase
          .from('trader_snapshots')
          .select(`
            source,
            source_trader_id,
            roi,
            pnl,
            win_rate,
            max_drawdown,
            followers,
            rank,
            season_id,
            captured_at
          `)
          .eq('captured_at', latestSnapshot.captured_at)
          .order('roi', { ascending: false })
          .limit(actualLimit)

        if (source !== 'all') {
          tradersQuery = tradersQuery.eq('source', source)
        }

        if (period !== 'all') {
          tradersQuery = tradersQuery.eq('season_id', period)
        } else {
          tradersQuery = tradersQuery.eq('season_id', '90D')
        }

        const { data: traders, error } = await tradersQuery

        if (error) {
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }

        // 获取 handle 映射
        const traderIds = traders?.map(t => t.source_trader_id) || []
        const { data: sources } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, source')
          .in('source_trader_id', traderIds)

        const handleMap = new Map()
        sources?.forEach(s => {
          handleMap.set(`${s.source}-${s.source_trader_id}`, s.handle || s.source_trader_id)
        })

        data = (traders || []).map(t => ({
          source: t.source,
          trader_id: t.source_trader_id,
          handle: handleMap.get(`${t.source}-${t.source_trader_id}`) || t.source_trader_id,
          roi: t.roi,
          pnl: t.pnl,
          win_rate: t.win_rate,
          max_drawdown: t.max_drawdown,
          followers: t.followers,
          rank: t.rank,
          period: t.season_id || '90D',
          captured_at: t.captured_at,
        }))
      }
    } else if (type === 'snapshots') {
      // 导出历史快照数据
      let snapshotsQuery = supabase
        .from('trader_snapshots')
        .select(`
          source,
          source_trader_id,
          roi,
          pnl,
          win_rate,
          max_drawdown,
          followers,
          rank,
          season_id,
          captured_at
        `)
        .order('captured_at', { ascending: false })
        .limit(actualLimit)

      if (source !== 'all') {
        snapshotsQuery = snapshotsQuery.eq('source', source)
      }

      const { data: snapshots, error } = await snapshotsQuery

      if (error) {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }

      data = snapshots || []
    }

    // 根据格式返回数据
    if (format === 'json') {
      return NextResponse.json({
        type,
        source,
        period,
        count: data.length,
        exported_at: new Date().toISOString(),
        data,
      })
    }

    // CSV 格式
    if (data.length === 0) {
      return new NextResponse('No data available', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${type}_export.csv"`,
        },
      })
    }

    const headers = Object.keys(data[0])
    const csvRows = [
      headers.join(','),
      ...data.map(row =>
        headers.map(h => {
          const val = row[h]
          if (val === null || val === undefined) return ''
          if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
            return `"${val.replace(/"/g, '""')}"`
          }
          return String(val)
        }).join(',')
      ),
    ]
    const csvContent = csvRows.join('\n')

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${type}_${source}_${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (error: unknown) {
    console.error('[export] Error:', error)
    const message = error instanceof Error ? error.message : 'Export failed'
    return NextResponse.json(
      { error: message },
      { status: 500 }
    )
  }
}

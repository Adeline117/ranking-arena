/**
 * 交易员技术指标 API
 * 
 * 从 trader_snapshots 表获取历史 ROI 数据，计算技术分析指标
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { resolveTrader } from '@/lib/data/unified'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import { computeIndicators, IndicatorResults } from '@/lib/utils/technical-analysis'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('trader-indicators-api')

export const revalidate = 300 // 5分钟

interface SnapshotRow {
  roi: number | null
  captured_at: string
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params

    if (!handle || handle.length > 255) {
      return NextResponse.json({ error: 'Invalid handle' }, { status: 400 })
    }

    // 检查缓存
    const cacheKey = `indicators:${handle}`
    const cached = getServerCache<IndicatorResults>(cacheKey)
    if (cached) {
      return NextResponse.json(cached)
    }

    const supabase = getSupabaseAdmin()

    // 查找交易员 via unified resolveTrader
    const resolved = await resolveTrader(supabase, { handle })
    if (!resolved) {
      return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    }

    // 获取历史快照数据（按时间升序）
    const { data: snapshots, error } = await supabase
      .from('trader_snapshots')
      .select('roi, captured_at')
      .eq('source_trader_id', resolved.traderKey)
      .eq('source', resolved.platform)
      .not('roi', 'is', null)
      .order('captured_at', { ascending: true })
      .limit(1000) as { data: SnapshotRow[] | null; error: { message: string } | null }

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 })
    }

    if (!snapshots || snapshots.length === 0) {
      return NextResponse.json({ error: 'No snapshot data available' }, { status: 404 })
    }

    const timestamps = snapshots.map(s => s.captured_at)
    const roiValues = snapshots.map(s => s.roi!)

    const results = computeIndicators(timestamps, roiValues)

    // 缓存 5 分钟
    setServerCache(cacheKey, results, CacheTTL.MEDIUM)

    const response = NextResponse.json(results)
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return response
  } catch (err) {
    logger.error('GET /api/traders/[handle]/indicators failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * 交易员技术指标 API
 *
 * 从 trader_snapshots_v2 表获取历史 ROI 数据，计算技术分析指标
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import { computeIndicators, IndicatorResults } from '@/lib/utils/technical-analysis'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('trader-indicators-api')

export const revalidate = 300 // 5分钟

interface SnapshotRow {
  roi_pct: number | null
  created_at: string
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

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

    // 历史日快照（按时间升序）。迁离退役的 trader_snapshots_v2 → trader_daily_snapshots。
    const { data: snapshots, error } = (await supabase
      .from('trader_daily_snapshots')
      .select('roi, date')
      .eq('trader_key', resolved.traderKey)
      .eq('platform', resolved.platform)
      .not('roi', 'is', null)
      .order('date', { ascending: true })
      .limit(1000)) as {
      data: Array<{ roi: number | null; date: string }> | null
      error: { message: string } | null
    }

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 })
    }

    if (!snapshots || snapshots.length === 0) {
      return NextResponse.json({ error: 'No snapshot data available' }, { status: 404 })
    }

    const timestamps = snapshots.map((s) => s.date)
    const roiValues = snapshots.map((s) => s.roi!)

    const results = computeIndicators(timestamps, roiValues)

    // 缓存 5 分钟
    setServerCache(cacheKey, results, CacheTTL.MEDIUM)

    const response = NextResponse.json(results)
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return response
  } catch (err) {
    logger.error('GET /api/traders/[handle]/indicators failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

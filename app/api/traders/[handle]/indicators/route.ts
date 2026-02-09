/**
 * 交易员技术指标 API
 * 
 * 从 trader_snapshots 表获取历史 ROI 数据，计算技术分析指标
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'
import { computeIndicators, IndicatorResults } from '@/lib/utils/technical-analysis'

export const revalidate = 300 // 5分钟

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const TRADER_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'] as const
type SourceType = typeof TRADER_SOURCES[number]

interface TraderSourceResult {
  source_trader_id: string
}

interface SnapshotRow {
  roi: number | null
  captured_at: string
}

/**
 * 查找交易员来源
 */
async function findTraderSource(
  supabase: ReturnType<typeof createClient<any>>,
  handle: string
): Promise<{ traderId: string; source: SourceType } | null> {
  const decodedHandle = decodeURIComponent(handle)

  for (const sourceType of TRADER_SOURCES) {
    const { data: byHandle } = await supabase
      .from('trader_sources')
      .select('source_trader_id')
      .eq('source', sourceType)
      .eq('handle', decodedHandle)
      .limit(1)
      .maybeSingle() as { data: TraderSourceResult | null }

    if (byHandle) {
      return { traderId: byHandle.source_trader_id, source: sourceType }
    }

    const { data: byId } = await supabase
      .from('trader_sources')
      .select('source_trader_id')
      .eq('source', sourceType)
      .eq('source_trader_id', decodedHandle)
      .limit(1)
      .maybeSingle() as { data: TraderSourceResult | null }

    if (byId) {
      return { traderId: byId.source_trader_id, source: sourceType }
    }
  }

  return null
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

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 查找交易员
    const traderInfo = await findTraderSource(supabase, handle)
    if (!traderInfo) {
      return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    }

    // 获取历史快照数据（按时间升序）
    const { data: snapshots, error } = await supabase
      .from('trader_snapshots')
      .select('roi, captured_at')
      .eq('source_trader_id', traderInfo.traderId)
      .eq('source', traderInfo.source)
      .not('roi', 'is', null)
      .order('captured_at', { ascending: true })
      .limit(1000) as { data: SnapshotRow[] | null; error: any }

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

    return NextResponse.json(results)
  } catch (_err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

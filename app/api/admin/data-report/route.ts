/**
 * 数据校验报告 API
 * 
 * 返回每个平台每个时间段的 TOP 10 交易员数据
 * 用于管理员检查数据抓取是否正常
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/utils/logger'
import {
  ALL_SOURCES as ALL_SOURCE_IDS,
  SOURCE_TYPE_MAP,
  EXCHANGE_NAMES,
} from '@/lib/constants/exchanges'

export const dynamic = 'force-dynamic'

// Build data-report source configs from shared constants
const ALL_SOURCES = ALL_SOURCE_IDS
  .filter(s => EXCHANGE_NAMES[s]) // only sources with display names
  .map(source => ({
    source,
    displayName: EXCHANGE_NAMES[source] || source,
    type: SOURCE_TYPE_MAP[source] || 'futures',
    periods: source === 'gmx' ? ['7D', '30D'] : ['7D', '30D', '90D'],
  }))

// 数据陈旧阈值（小时）
const STALE_THRESHOLD_HOURS = 24

interface TraderData {
  traderId: string
  handle: string | null
  roi: number
  pnl: number | null
  winRate: number | null
  rank: number
}

interface PeriodReport {
  period: string
  lastUpdate: string | null
  isStale: boolean
  traderCount: number
  top10: TraderData[]
}

interface SourceReport {
  source: string
  displayName: string
  type: string
  periods: PeriodReport[]
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!url || !key) {
    throw new Error('Supabase env missing')
  }
  
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function GET(req: Request) {
  try {
    // 认证检查：必须是管理员
    const authHeader = req.headers.get('authorization')
    const supabase = getSupabaseClient()

    const { verifyAdmin } = await import('@/lib/admin/auth')
    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized: Admin access required' },
        { status: 401 }
      )
    }
    const now = new Date()
    const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000)
    
    // 并行获取所有数据源的报告（而非串行）
    const reports: SourceReport[] = await Promise.all(
      ALL_SOURCES.map(async (sourceConfig) => {
        const periodReports: PeriodReport[] = await Promise.all(
          sourceConfig.periods.map(async (period) => {
            // 获取最新的 captured_at
            const { data: latestSnapshot } = await supabase
              .from('trader_snapshots')
              .select('captured_at')
              .eq('source', sourceConfig.source)
              .eq('season_id', period)
              .order('captured_at', { ascending: false })
              .limit(1)
              .maybeSingle()

            const lastUpdate = latestSnapshot?.captured_at || null
            const isStale = lastUpdate ? new Date(lastUpdate) < staleThreshold : true

            // 并行获取交易员数量和 TOP 10
            const [countResult, snapshotsResult] = await Promise.all([
              supabase
                .from('trader_snapshots')
                .select('*', { count: 'exact', head: true })
                .eq('source', sourceConfig.source)
                .eq('season_id', period)
                .eq('captured_at', lastUpdate),
              lastUpdate
                ? supabase
                    .from('trader_snapshots')
                    .select('source_trader_id, roi, pnl, win_rate, rank')
                    .eq('source', sourceConfig.source)
                    .eq('season_id', period)
                    .eq('captured_at', lastUpdate)
                    .order('roi', { ascending: false })
                    .limit(10)
                : Promise.resolve({ data: null }),
            ])

            let top10: TraderData[] = []
            const snapshots = snapshotsResult.data
            if (snapshots && snapshots.length > 0) {
              const traderIds = snapshots.map(s => s.source_trader_id)
              const { data: sources } = await supabase
                .from('trader_sources')
                .select('source_trader_id, handle')
                .eq('source', sourceConfig.source)
                .in('source_trader_id', traderIds)

              const handleMap = new Map<string, string | null>()
              sources?.forEach(s => handleMap.set(s.source_trader_id, s.handle))

              top10 = snapshots.map((s, idx) => ({
                traderId: s.source_trader_id,
                handle: handleMap.get(s.source_trader_id) || null,
                roi: s.roi ?? 0,
                pnl: s.pnl ?? null,
                winRate: s.win_rate ?? null,
                rank: idx + 1,
              }))
            }

            return {
              period,
              lastUpdate,
              isStale,
              traderCount: countResult.count || 0,
              top10,
            }
          })
        )

        return {
          source: sourceConfig.source,
          displayName: sourceConfig.displayName,
          type: sourceConfig.type,
          periods: periodReports,
        }
      })
    )
    
    // 计算统计信息
    const stats = {
      totalSources: ALL_SOURCES.length,
      healthySources: reports.filter(r => r.periods.every(p => !p.isStale)).length,
      staleSources: reports.filter(r => r.periods.some(p => p.isStale)).length,
      lastGenerated: now.toISOString(),
    }
    
    return NextResponse.json({
      ok: true,
      stats,
      reports,
    })
  } catch (error: unknown) {
    logger.error('Data report error', { error })
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json(
      { ok: false, error: errorMessage },
      { status: 500 }
    )
  }
}

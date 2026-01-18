/**
 * 数据校验报告 API
 * 
 * 返回每个平台每个时间段的 TOP 10 交易员数据
 * 用于管理员检查数据抓取是否正常
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// 所有数据源配置
const ALL_SOURCES = [
  { source: 'binance_futures', displayName: 'Binance Futures', type: 'futures', periods: ['7D', '30D', '90D'] },
  { source: 'binance_spot', displayName: 'Binance Spot', type: 'spot', periods: ['7D', '30D', '90D'] },
  { source: 'binance_web3', displayName: 'Binance Web3', type: 'web3', periods: ['7D', '30D', '90D'] },
  { source: 'bybit', displayName: 'Bybit', type: 'futures', periods: ['7D', '30D', '90D'] },
  { source: 'bitget_futures', displayName: 'Bitget Futures', type: 'futures', periods: ['7D', '30D', '90D'] },
  { source: 'bitget_spot', displayName: 'Bitget Spot', type: 'spot', periods: ['7D', '30D', '90D'] },
  { source: 'mexc', displayName: 'MEXC', type: 'futures', periods: ['7D', '30D', '90D'] },
  { source: 'coinex', displayName: 'CoinEx', type: 'futures', periods: ['7D', '30D', '90D'] },
  { source: 'okx_web3', displayName: 'OKX Web3', type: 'web3', periods: ['7D', '30D', '90D'] },
  { source: 'kucoin', displayName: 'KuCoin', type: 'futures', periods: ['7D', '30D', '90D'] },
  { source: 'gmx', displayName: 'GMX', type: 'web3', periods: ['7D', '30D'] }, // GMX 只有 7D 和 30D
]

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
    // 简单的认证检查（可以根据需要加强）
    const authHeader = req.headers.get('authorization')
    
    const supabase = getSupabaseClient()
    const now = new Date()
    const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000)
    
    const reports: SourceReport[] = []
    
    // 为每个数据源生成报告
    for (const sourceConfig of ALL_SOURCES) {
      const periodReports: PeriodReport[] = []
      
      for (const period of sourceConfig.periods) {
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
        
        // 获取该时间段的交易员数量
        const { count } = await supabase
          .from('trader_snapshots')
          .select('*', { count: 'exact', head: true })
          .eq('source', sourceConfig.source)
          .eq('season_id', period)
          .eq('captured_at', lastUpdate)
        
        // 获取 TOP 10
        let top10: TraderData[] = []
        if (lastUpdate) {
          const { data: snapshots } = await supabase
            .from('trader_snapshots')
            .select('source_trader_id, roi, pnl, win_rate, rank')
            .eq('source', sourceConfig.source)
            .eq('season_id', period)
            .eq('captured_at', lastUpdate)
            .order('roi', { ascending: false })
            .limit(10)
          
          if (snapshots && snapshots.length > 0) {
            // 批量获取 handles
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
        }
        
        periodReports.push({
          period,
          lastUpdate,
          isStale,
          traderCount: count || 0,
          top10,
        })
      }
      
      reports.push({
        source: sourceConfig.source,
        displayName: sourceConfig.displayName,
        type: sourceConfig.type,
        periods: periodReports,
      })
    }
    
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
  } catch (error: any) {
    console.error('Data report error:', error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    )
  }
}

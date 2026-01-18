/**
 * 热门交易员高频更新 Cron
 * 每 15 分钟更新 Top 100 交易员数据
 * 
 * GET /api/cron/fetch-hot-traders - 健康检查
 * POST /api/cron/fetch-hot-traders - 执行更新
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 验证 Cron 密钥
function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    console.warn('[HotTraders Cron] CRON_SECRET 未配置')
    return false
  }

  return authHeader === `Bearer ${cronSecret}`
}

// 获取 Supabase Admin 客户端
function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error('Supabase 环境变量未配置')
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

// 支持的交易所
const SOURCES = [
  'binance_futures',
  'binance_spot',
  'bybit',
  'bitget_futures',
  'bitget_spot',
]

/**
 * GET - 健康检查
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'Hot traders cron endpoint ready',
    sources: SOURCES,
    updateInterval: '15 minutes',
  })
}

/**
 * POST - 执行热门交易员更新
 * 只更新 Top 100 的交易员数据
 */
export async function POST(req: Request) {
  const startTime = Date.now()

  try {
    // 验证授权
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const results: Array<{ source: string; status: string; count?: number; error?: string }> = []

    // 获取各交易所的 Top 100 交易员
    for (const source of SOURCES) {
      try {
        // 获取该交易所最新的 Top 100 交易员 ID
        const { data: topTraders, error: fetchError } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id')
          .eq('source', source)
          .eq('season_id', '90D')
          .order('roi', { ascending: false })
          .limit(100)

        if (fetchError) {
          console.error(`[HotTraders Cron] ${source} 获取 Top 交易员失败:`, fetchError)
          results.push({ source, status: 'error', error: fetchError.message })
          continue
        }

        if (!topTraders || topTraders.length === 0) {
          results.push({ source, status: 'skipped', count: 0 })
          continue
        }

        const traderIds = topTraders.map(t => t.source_trader_id)
        
        // 这里可以调用各交易所的 API 更新数据
        // 由于各交易所 API 调用逻辑在 scripts 目录中
        // 我们这里只记录需要更新的交易员数量
        // 实际的高频更新可以通过 Cloudflare Workers 或独立服务实现
        
        console.log(`[HotTraders Cron] ${source}: ${traderIds.length} 个 Top 交易员需要更新`)
        
        results.push({
          source,
          status: 'identified',
          count: traderIds.length,
        })
      } catch (error) {
        console.error(`[HotTraders Cron] ${source} 处理失败:`, error)
        results.push({
          source,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      ok: true,
      message: 'Hot traders check completed',
      duration: `${duration}ms`,
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[HotTraders Cron] 执行失败:', error)
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}

/**
 * 关注交易员按需更新 Cron
 * 每小时更新有用户关注的交易员数据
 *
 * GET /api/cron/fetch-followed-traders - 执行更新 (Vercel Cron 调用)
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runTraderAlertDetection } from '@/lib/services/trader-alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// 验证 Cron 密钥 (Vercel Cron 使用 Authorization: Bearer 格式)
function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // 开发环境允许无密钥访问
  if (!cronSecret && process.env.NODE_ENV === 'development') {
    return true
  }

  if (!cronSecret) {
    console.warn('[FollowedTraders Cron] CRON_SECRET 未配置')
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

/**
 * GET - 执行关注交易员更新 (Vercel Cron 调用此端点)
 */
export async function GET(req: Request) {
  const startTime = Date.now()

  try {
    // 验证授权
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()

    // 获取有用户关注的交易员列表（去重）
    const { data: followedTraders, error: fetchError } = await supabase
      .from('trader_follows')
      .select('trader_id, source')
      .order('created_at', { ascending: false })

    if (fetchError) {
      console.error('[FollowedTraders Cron] 获取关注列表失败:', fetchError)
      return NextResponse.json(
        { ok: false, error: fetchError.message },
        { status: 500 }
      )
    }

    if (!followedTraders || followedTraders.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No followed traders to update',
        count: 0,
      })
    }

    // 按交易所分组
    const tradersBySource = new Map<string, Set<string>>()
    for (const follow of followedTraders) {
      const source = follow.source || 'binance_futures'
      if (!tradersBySource.has(source)) {
        tradersBySource.set(source, new Set())
      }
      tradersBySource.get(source)!.add(follow.trader_id)
    }

    const results: Array<{ source: string; count: number }> = []
    let totalCount = 0

    for (const [source, traderIds] of tradersBySource) {
      const count = traderIds.size
      totalCount += count
      results.push({ source, count })

    }

    // 6. 运行异动检测
    let alertResult = { tradersChecked: 0, alertsDetected: 0, notificationsSaved: 0, errors: 0 }
    try {
      const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
      if (supabaseUrl && supabaseKey) {
        alertResult = await runTraderAlertDetection(supabaseUrl, supabaseKey)
      }
    } catch (alertError) {
      console.error('[FollowedTraders Cron] 异动检测失败:', alertError)
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      ok: true,
      message: 'Followed traders check completed',
      duration: `${duration}ms`,
      totalFollowedTraders: totalCount,
      bySource: results,
      alertDetection: alertResult,
      timestamp: new Date().toISOString(),
    })
  } catch (error: unknown) {
    console.error('[FollowedTraders Cron] 执行失败:', error)
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}

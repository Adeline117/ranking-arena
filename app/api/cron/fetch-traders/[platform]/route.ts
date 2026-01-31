/**
 * 单平台交易员数据抓取 API
 * GET /api/cron/fetch-traders/[platform]
 *
 * 支持的平台:
 * - binance_futures, binance_spot, binance_web3
 * - bybit
 * - bitget_futures, bitget_spot
 * - mexc, coinex
 * - okx_futures, okx_web3
 * - kucoin, gmx, htx, weex
 *
 * Smart Scheduler Integration:
 * When ENABLE_SMART_SCHEDULER=true, this endpoint checks whether any
 * traders on the platform are due for refresh (next_refresh_at <= NOW).
 * If none are due, the run is skipped to save API quota. After a
 * successful run the schedule manager updates next_refresh_at for all
 * traders on the platform.
 *
 * Vercel Cron 通过 GET 请求调用，使用 Authorization: Bearer 验证
 */

import { NextResponse } from 'next/server'
import {
  createSupabaseAdmin,
  executePlatformScripts,
  logCronExecution,
  getSupportedPlatforms,
  getSupabaseEnv,
} from '@/lib/cron/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5分钟最大执行时间 (Pro plan)

type Params = {
  params: Promise<{ platform: string }>
}

/**
 * 验证 Vercel Cron 授权
 * Vercel Cron 使用 Authorization: Bearer <CRON_SECRET> 格式
 */
function isVercelCronAuthorized(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // 开发环境允许无密钥访问
  if (!cronSecret && process.env.NODE_ENV === 'development') {
    return true
  }

  if (!cronSecret) {
    console.error('[Cron] CRON_SECRET 环境变量未设置')
    return false
  }

  return authHeader === `Bearer ${cronSecret}`
}

function isSmartSchedulerEnabled(): boolean {
  return process.env.ENABLE_SMART_SCHEDULER === 'true'
}

/**
 * Check if any traders on the platform are due for refresh.
 * Returns the count of overdue traders, or null if the check fails
 * (in which case we fall through to the normal run).
 */
async function countOverdueTraders(platform: string): Promise<number | null> {
  try {
    const supabase = createSupabaseAdmin()
    if (!supabase) return null

    const now = new Date().toISOString()
    const { count, error } = await supabase
      .from('trader_sources')
      .select('id', { count: 'exact', head: true })
      .eq('source', platform)
      .eq('is_active', true)
      .lte('next_refresh_at', now)

    if (error) {
      console.warn(`[Cron] Smart scheduler check failed for ${platform}:`, error.message)
      return null // fall through to normal run
    }

    return count ?? 0
  } catch {
    return null // fall through to normal run
  }
}

/**
 * After a successful refresh, update next_refresh_at for all active traders
 * on this platform so the scheduler knows when to run next.
 */
async function markPlatformRefreshed(platform: string): Promise<void> {
  try {
    const { createScheduleManager } = await import('@/lib/services/schedule-manager')
    const manager = createScheduleManager()
    const traders = await manager.getTradersToRefresh({ platform, limit: 10000 })
    if (traders.length > 0) {
      await manager.markRefreshed(traders.map(t => t.id))
    }
  } catch (err) {
    console.warn(`[Cron] Failed to update refresh schedule for ${platform}:`, err)
  }
}

/**
 * GET /api/cron/fetch-traders/[platform]
 * Vercel Cron 调用此端点执行抓取任务
 */
export async function GET(request: Request, { params }: Params) {
  const { platform } = await params

  try {
    // 1) 验证授权 (Vercel Cron 使用 Authorization: Bearer 格式)
    if (!isVercelCronAuthorized(request)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    // 2) 验证平台
    const supported = getSupportedPlatforms()
    if (!supported.includes(platform)) {
      return NextResponse.json(
        {
          error: `未知平台: ${platform}`,
          supported,
        },
        { status: 400 }
      )
    }

    // 3) 验证环境变量
    const { url, serviceKey } = getSupabaseEnv()
    if (!url || !serviceKey) {
      return NextResponse.json(
        {
          error: 'Supabase 环境变量缺失',
          missing: { url: !url, serviceKey: !serviceKey },
        },
        { status: 500 }
      )
    }

    // 3.5) Smart Scheduler: skip if no traders are due for refresh
    if (isSmartSchedulerEnabled()) {
      const overdueCount = await countOverdueTraders(platform)
      if (overdueCount === 0) {
        return NextResponse.json({
          ok: true,
          platform,
          skipped: true,
          reason: 'No traders due for refresh (smart scheduler)',
          ran_at: new Date().toISOString(),
        })
      }
      // overdueCount === null means check failed — fall through to normal run
    }

    // 4) 执行平台脚本
    const { results, ran_at } = await executePlatformScripts(platform)

    // 5) 记录日志
    const supabase = createSupabaseAdmin()
    await logCronExecution(supabase, `fetch-traders-${platform}`, results)

    // 5.5) Smart Scheduler: update next_refresh_at after successful run
    const successCount = results.filter((r) => r.success).length
    if (isSmartSchedulerEnabled() && successCount > 0) {
      await markPlatformRefreshed(platform)
    }

    // 6) 返回结果
    const failCount = results.length - successCount

    return NextResponse.json({
      ok: failCount === 0,
      platform,
      ran_at,
      summary: {
        total: results.length,
        success: successCount,
        failed: failCount,
      },
      results,
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[Cron] ${platform} 执行失败:`, errorMessage)

    return NextResponse.json(
      {
        ok: false,
        platform,
        error: errorMessage,
      },
      { status: 500 }
    )
  }
}

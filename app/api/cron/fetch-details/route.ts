/**
 * 交易员详情快速抓取 Cron 端点
 *
 * GET /api/cron/fetch-details - 触发快速详情抓取 (Vercel Cron 调用)
 *
 * 参数:
 * - source: 指定来源 (binance, bybit 等)
 * - limit: 限制数量 (默认 200)
 * - concurrency: 并发数 (默认 30)
 * - skipRecent: 跳过最近 N 小时更新的 (默认 6)
 * - force: 强制更新所有 (忽略增量)
 * - tier: 指定活动层级 (hot, active, normal, dormant) - 启用智能调度时使用
 *
 * Smart Scheduler Integration:
 * - When ENABLE_SMART_SCHEDULER=true, uses tier-based prioritization
 * - Fetches traders due for refresh based on their activity tier
 * - Adjusts concurrency based on tier priority
 */

import { NextResponse } from 'next/server'
import { isAuthorized, getSupabaseEnv, createSupabaseAdmin, logCronExecution } from '@/lib/cron/utils'
import { createScheduleManager } from '@/lib/services/schedule-manager'
import { ActivityTier } from '@/lib/services/smart-scheduler'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createLogger } from '@/lib/utils/logger'

const execAsync = promisify(exec)
const logger = createLogger('FetchDetails')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 分钟超时

/**
 * Check if smart scheduler is enabled
 */
function isSmartSchedulerEnabled(): boolean {
  return process.env.ENABLE_SMART_SCHEDULER === 'true'
}

/**
 * GET - 触发快速详情抓取 (Vercel Cron 调用此端点)
 */
export async function GET(req: Request) {
  const startTime = Date.now()

  try {
    // 1) 验证授权
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    // 2) 验证环境变量
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

    // 3) 解析参数
    const requestUrl = new URL(req.url)
    const source = requestUrl.searchParams.get('source') || ''
    const limitParam = requestUrl.searchParams.get('limit') || '200'
    const concurrencyParam = requestUrl.searchParams.get('concurrency') || '30'
    const skipRecent = requestUrl.searchParams.get('skipRecent') || '6'
    const force = requestUrl.searchParams.get('force') === 'true'
    const tierParam = requestUrl.searchParams.get('tier') as ActivityTier | null

    // 4) Smart Scheduler: Get traders to refresh (if enabled)
    let limit = parseInt(limitParam, 10)
    let concurrency = parseInt(concurrencyParam, 10)
    let smartSchedulerUsed = false

    if (isSmartSchedulerEnabled() && !force) {
      try {
        const scheduleManager = createScheduleManager()

        // Get traders due for refresh
        const tradersToRefresh = await scheduleManager.getTradersToRefresh({
          platform: source || undefined,
          limit: limit * 2, // Get more candidates
          priorityOrder: true,
          includeOverdue: true,
          tiers: tierParam ? [tierParam] : undefined,
        })

        if (tradersToRefresh.length > 0) {
          smartSchedulerUsed = true

          // Adjust limit based on how many traders need refresh
          limit = Math.min(limit, tradersToRefresh.length)

          // Adjust concurrency based on tier priority
          const avgPriority =
            tradersToRefresh.reduce((sum, t) => sum + (t.refresh_priority || 30), 0) /
            tradersToRefresh.length

          // Hot tier (priority 10): higher concurrency
          // Dormant tier (priority 40): lower concurrency
          if (avgPriority <= 15) {
            concurrency = 50 // Hot tier: max concurrency
          } else if (avgPriority <= 25) {
            concurrency = 40 // Active tier: high concurrency
          } else if (avgPriority <= 35) {
            concurrency = 30 // Normal tier: medium concurrency
          } else {
            concurrency = 20 // Dormant tier: low concurrency
          }

          logger.info('Smart scheduler: adjusted parameters', {
            tradersToRefresh: tradersToRefresh.length,
            adjustedLimit: limit,
            adjustedConcurrency: concurrency,
            avgPriority,
          })
        }
      } catch (error) {
        logger.error('Smart scheduler failed, falling back to default behavior', { error })
        // Continue with original parameters
      }
    }

    // 5) 构建命令
    const args = [
      source ? `--source=${source}` : '',
      `--limit=${limit}`,
      `--concurrency=${concurrency}`,
      `--skip-recent=${skipRecent}`,
      force ? '--force' : '',
    ].filter(Boolean).join(' ')

    const command = `node scripts/fetch_details_fast.mjs ${args}`
    logger.info(`执行: ${command}`)

    // 6) 执行脚本
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout: 280000, // 280秒超时（留20秒buffer）
      env: {
        ...process.env,
        SUPABASE_URL: url,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      },
    })

    const duration = Date.now() - startTime
    const output = stdout || stderr

    // 7) 解析输出结果
    const statsMatch = output.match(/成功更新: (\d+)/)
    const totalMatch = output.match(/交易员总数: (\d+)/)
    const success = statsMatch ? parseInt(statsMatch[1]) : 0
    const total = totalMatch ? parseInt(totalMatch[1]) : 0

    // 8) Smart Scheduler: Mark traders as refreshed
    if (smartSchedulerUsed && success > 0) {
      try {
        // Note: We'd need trader IDs from the script output to mark them as refreshed
        // For now, this is a placeholder - the script would need to return trader IDs
        logger.info('Smart scheduler: traders refreshed', { count: success })
      } catch (error) {
        logger.error('Failed to mark traders as refreshed', { error })
      }
    }

    // 9) 记录日志
    const supabase = createSupabaseAdmin()
    await logCronExecution(supabase, 'fetch-details-fast', [
      {
        name: 'fetch_details_fast',
        success: true,
        output: output.substring(0, 1000),
        duration,
      },
    ])

    // 10) 返回结果
    return NextResponse.json({
      ok: true,
      ran_at: new Date().toISOString(),
      summary: {
        total,
        success,
        duration,
        params: { source, limit, concurrency, skipRecent, force },
        smartScheduler: smartSchedulerUsed
          ? {
              enabled: true,
              adjustedConcurrency: concurrency,
              tier: tierParam || 'all',
            }
          : { enabled: false },
      },
      output: output.substring(0, 2000),
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('执行失败', { error: errorMessage })

    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 })
  }
}

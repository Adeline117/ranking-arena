/**
 * @deprecated Use /api/cron/batch-fetch-traders instead (primary production route).
 * This legacy endpoint runs ALL platforms sequentially and is only kept for manual
 * debugging. It is NOT scheduled in vercel.json crons.
 *
 * GET /api/cron/fetch-traders - 健康检查
 * POST /api/cron/fetch-traders - 触发所有平台抓取（仅用于手动触发/调试）
 */

import { NextResponse } from 'next/server'
import {
  isAuthorized,
  createSupabaseAdmin,
  executePlatformScripts,
  logCronExecution,
  getSupportedPlatforms,
  getSupabaseEnv,
  sendScrapeSummaryAlert,
  type ScriptResult,
} from '@/lib/cron/utils'
import { logger } from '@/lib/logger'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX US geo-blocking
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET - 健康检查
 */
export async function GET() {
  const platforms = getSupportedPlatforms()
  const { url, serviceKey } = getSupabaseEnv()

  return NextResponse.json({
    ok: true,
    message: 'Cron endpoint healthy',
    platforms,
    config: {
      hasSupabaseUrl: !!url,
      hasServiceKey: !!serviceKey,
      hasCronSecret: !!env.CRON_SECRET,
    },
  })
}

/**
 * POST - 触发所有平台抓取
 * 警告: 此端点会执行所有平台的抓取脚本，可能超时
 * 生产环境建议使用 /api/cron/fetch-traders/[platform] 分别调度
 */
export async function POST(req: Request) {
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
          error: 'Supabase environment variables missing',
          missing: { url: !url, serviceKey: !serviceKey },
        },
        { status: 500 }
      )
    }

    // 3) 检查是否只运行特定平台（通过 query param）
    const requestUrl = new URL(req.url)
    const platformParam = requestUrl.searchParams.get('platform')
    const platforms = platformParam
      ? platformParam.split(',').filter((p) => getSupportedPlatforms().includes(p))
      : getSupportedPlatforms()

    if (platforms.length === 0) {
      return NextResponse.json(
        {
          error: 'No valid platforms',
          supported: getSupportedPlatforms(),
        },
        { status: 400 }
      )
    }

    const now = new Date().toISOString()
    const allResults: Array<{ platform: string; results: ScriptResult[] }> = []
    let totalSuccess = 0
    let totalFailed = 0
    const failedDetails: Array<{ platform: string; scripts: string[] }> = []

    // 4) 顺序执行各平台脚本
    for (const platform of platforms) {
      try {
        const { results } = await executePlatformScripts(platform)
        allResults.push({ platform, results })

        const successCount = results.filter((r) => r.success).length
        const failedScripts = results.filter((r) => !r.success).map((r) => r.name)
        
        totalSuccess += successCount
        totalFailed += results.length - successCount
        
        if (failedScripts.length > 0) {
          failedDetails.push({ platform, scripts: failedScripts })
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(`Platform ${platform} fetch failed`, { platform }, error instanceof Error ? error : new Error(errorMessage))
        allResults.push({
          platform,
          results: [{ name: platform, success: false, error: errorMessage }],
        })
        totalFailed++
        failedDetails.push({ platform, scripts: [platform] })
      }
    }

    // 5) 记录日志
    const supabase = createSupabaseAdmin()
    const flatResults = allResults.flatMap((p) => p.results)
    await logCronExecution(supabase, 'fetch-traders-all', flatResults)

    // 6) 发送批量执行摘要告警（如果有失败）
    const duration = Date.now() - startTime
    const successPlatforms = platforms.length - failedDetails.length
    
    await sendScrapeSummaryAlert({
      totalPlatforms: platforms.length,
      successPlatforms,
      failedPlatforms: failedDetails.length,
      totalScripts: totalSuccess + totalFailed,
      successScripts: totalSuccess,
      failedScripts: totalFailed,
      duration,
      failedDetails: failedDetails.length > 0 ? failedDetails : undefined,
    })

    // 7) 返回结果
    return NextResponse.json({
      ok: totalFailed === 0,
      ran_at: now,
      summary: {
        platforms: platforms.length,
        total: totalSuccess + totalFailed,
        success: totalSuccess,
        failed: totalFailed,
        duration,
      },
      results: allResults,
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.apiError('/api/cron/fetch-traders', error, {})

    return NextResponse.json(
      { ok: false, error: errorMessage },
      { status: 500 }
    )
  }
}

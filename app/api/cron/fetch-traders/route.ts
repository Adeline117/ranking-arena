/**
 * 交易员数据抓取 Cron 主入口
 * 
 * GET /api/cron/fetch-traders - 健康检查
 * POST /api/cron/fetch-traders - 触发所有平台抓取（仅用于手动触发/调试）
 * 
 * 生产环境推荐使用各平台独立端点:
 * POST /api/cron/fetch-traders/[platform]
 * 
 * 支持的平台:
 * - binance_futures, binance_spot, binance_web3
 * - bybit
 * - bitget_futures, bitget_spot
 * - mexc, coinex
 * - okx_web3, kucoin, gmx
 */

import { NextResponse } from 'next/server'
import {
  isAuthorized,
  createSupabaseAdmin,
  executePlatformScripts,
  logCronExecution,
  getSupportedPlatforms,
  getSupabaseEnv,
  type ScriptResult,
} from '@/lib/cron/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET - 健康检查
 */
export async function GET() {
  const platforms = getSupportedPlatforms()
  const { url, serviceKey } = getSupabaseEnv()

  return NextResponse.json({
    ok: true,
    message: 'Cron 端点正常',
    platforms,
    config: {
      hasSupabaseUrl: !!url,
      hasServiceKey: !!serviceKey,
      hasCronSecret: !!process.env.CRON_SECRET,
    },
  })
}

/**
 * POST - 触发所有平台抓取
 * 警告: 此端点会执行所有平台的抓取脚本，可能超时
 * 生产环境建议使用 /api/cron/fetch-traders/[platform] 分别调度
 */
export async function POST(req: Request) {
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

    // 3) 检查是否只运行特定平台（通过 query param）
    const requestUrl = new URL(req.url)
    const platformParam = requestUrl.searchParams.get('platform')
    const platforms = platformParam
      ? platformParam.split(',').filter((p) => getSupportedPlatforms().includes(p))
      : getSupportedPlatforms()

    if (platforms.length === 0) {
      return NextResponse.json(
        {
          error: '无有效平台',
          supported: getSupportedPlatforms(),
        },
        { status: 400 }
      )
    }

    const now = new Date().toISOString()
    const allResults: Array<{ platform: string; results: ScriptResult[] }> = []
    let totalSuccess = 0
    let totalFailed = 0

    // 4) 顺序执行各平台脚本
    for (const platform of platforms) {
      try {
        console.log(`[Cron] 开始执行平台: ${platform}`)
        const { results } = await executePlatformScripts(platform)
        allResults.push({ platform, results })

        const successCount = results.filter((r) => r.success).length
        totalSuccess += successCount
        totalFailed += results.length - successCount
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.error(`[Cron] 平台 ${platform} 执行失败:`, errorMessage)
        allResults.push({
          platform,
          results: [{ name: platform, success: false, error: errorMessage }],
        })
        totalFailed++
      }
    }

    // 5) 记录日志
    const supabase = createSupabaseAdmin()
    const flatResults = allResults.flatMap((p) => p.results)
    await logCronExecution(supabase, 'fetch-traders-all', flatResults)

    // 6) 返回结果
    return NextResponse.json({
      ok: totalFailed === 0,
      ran_at: now,
      summary: {
        platforms: platforms.length,
        total: totalSuccess + totalFailed,
        success: totalSuccess,
        failed: totalFailed,
      },
      results: allResults,
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[Cron] 执行失败:', errorMessage)

    return NextResponse.json(
      { ok: false, error: errorMessage },
      { status: 500 }
    )
  }
}

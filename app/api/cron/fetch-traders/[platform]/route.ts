/**
 * 单平台交易员数据抓取 API
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
} from '@/lib/cron/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5分钟最大执行时间 (Pro plan)

type Params = {
  params: Promise<{ platform: string }>
}

export async function GET(request: Request, { params }: Params) {
  const { platform } = await params
  const supported = getSupportedPlatforms()

  return NextResponse.json({
    ok: true,
    platform,
    supported: supported.includes(platform),
    message: supported.includes(platform)
      ? `平台 ${platform} 端点正常`
      : `未知平台，支持的平台: ${supported.join(', ')}`,
  })
}

export async function POST(request: Request, { params }: Params) {
  const { platform } = await params

  try {
    // 1) 验证授权
    if (!isAuthorized(request)) {
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

    // 4) 执行平台脚本
    const { results, ran_at } = await executePlatformScripts(platform)

    // 5) 记录日志
    const supabase = createSupabaseAdmin()
    await logCronExecution(supabase, `fetch-traders-${platform}`, results)

    // 6) 返回结果
    const successCount = results.filter((r) => r.success).length
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

/**
 * Pipeline Fetch - New Architecture Cron Job
 *
 * 使用新的四层管道架构获取交易员数据：
 * 1. Scraper Layer - 纯采集
 * 2. Normalizer Layer - 标准化
 * 3. Calculator Layer - 计算 Arena Score
 * 4. Storage Layer - 存储
 *
 * Query params:
 *   platform=binance_futures,hyperliquid  → 指定平台（逗号分隔）
 *   windows=7d,30d,90d                    → 指定时间窗口
 *
 * 这是新管道的实验性入口，将逐步替换 batch-fetch-traders
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { createSupabaseAdmin } from '@/lib/cron/utils'
import { PipelineRunner, getScraper } from '@/lib/pipeline'
import type { TimeWindow, PipelineRunResult } from '@/lib/pipeline'

// Import scrapers to register them
import '@/lib/pipeline/scrapers'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

// 支持的平台（已迁移到新管道）
const SUPPORTED_PLATFORMS = [
  // CEX Futures
  'binance_futures',
  'okx_futures',
  'bybit',
  'bitget_futures',
  'mexc_futures',
  'htx_futures',
  'coinex',
  'gateio',
  'kucoin',
  'phemex',
  'bingx',
  'bitunix',
  'blofin',
  // DEX / Perp
  'hyperliquid',
  'gmx',
  'dydx',
  'drift',
  'aevo',
  'jupiter_perps',
  'gains',
  'kwenta',
  // Social Trading
  'etoro',
]

export async function GET(request: NextRequest) {
  // 验证 cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const platformsParam = searchParams.get('platform') || searchParams.get('platforms')
  const windowsParam = searchParams.get('window') || searchParams.get('windows')

  // 解析参数
  const platforms = platformsParam
    ? platformsParam.split(',').filter((p) => SUPPORTED_PLATFORMS.includes(p))
    : SUPPORTED_PLATFORMS

  const windows: TimeWindow[] = windowsParam
    ? (windowsParam.split(',').filter((w) => ['7d', '30d', '90d'].includes(w)) as TimeWindow[])
    : ['7d', '30d', '90d']

  if (platforms.length === 0) {
    return NextResponse.json(
      { error: `No supported platforms. Available: ${SUPPORTED_PLATFORMS.join(', ')}` },
      { status: 400 }
    )
  }

  // 初始化
  const supabase = createSupabaseAdmin()
  const plog = await PipelineLogger.start('pipeline-fetch')
  const startTime = Date.now()

  try {
    const results: PipelineRunResult[] = []

    // 串行处理每个平台
    for (const platform of platforms) {
      const platformStart = Date.now()

      try {
        // 检查 scraper 是否已注册
        const scraper = await getScraper(platform)
        if (!scraper) {
          console.warn(`[pipeline-fetch] No scraper for ${platform}, skipping`)
          continue
        }

        // 运行管道
        const runner = new PipelineRunner(supabase)
        const result = await runner.run({
          platforms: [platform],
          windows,
        })

        results.push(result)

        console.log(
          `[pipeline-fetch] ${platform}: ${result.summary.total_traders} traders, ` +
            `${result.summary.total_upserted} upserted, ` +
            `${Date.now() - platformStart}ms`
        )
      } catch (error) {
        console.error(`[pipeline-fetch] ${platform} failed:`, error)
        results.push({
          run_id: `error_${platform}_${Date.now()}`,
          started_at: new Date(platformStart),
          finished_at: new Date(),
          steps: [
            {
              platform,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
              duration_ms: Date.now() - platformStart,
            },
          ],
          summary: {
            total_platforms: 1,
            successful: 0,
            failed: 1,
            total_traders: 0,
            total_upserted: 0,
          },
        })
      }
    }

    // 汇总统计
    const totalTraders = results.reduce((sum, r) => sum + r.summary.total_traders, 0)
    const totalUpserted = results.reduce((sum, r) => sum + r.summary.total_upserted, 0)
    const successful = results.reduce((sum, r) => sum + r.summary.successful, 0)
    const failed = results.reduce((sum, r) => sum + r.summary.failed, 0)

    await plog.success(totalUpserted)

    return NextResponse.json({
      success: true,
      duration_ms: Date.now() - startTime,
      platforms_requested: platforms,
      windows_requested: windows,
      summary: {
        total_platforms: platforms.length,
        successful,
        failed,
        total_traders: totalTraders,
        total_upserted: totalUpserted,
      },
      results: results.map((r) => ({
        run_id: r.run_id,
        duration_ms: r.finished_at.getTime() - r.started_at.getTime(),
        steps: r.steps,
        summary: r.summary,
      })),
    })
  } catch (error) {
    await plog.error(error)

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startTime,
      },
      { status: 500 }
    )
  }
}

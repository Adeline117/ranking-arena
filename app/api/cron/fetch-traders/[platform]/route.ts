/**
 * 单平台交易员数据抓取 API (Inline — Vercel Serverless 兼容)
 * GET /api/cron/fetch-traders/[platform]
 *
 * 所有抓取逻辑内联在 lib/cron/fetchers/ 中，不依赖 child_process 或浏览器
 * Vercel Cron 通过 GET 请求调用，使用 Authorization: Bearer 验证
 */

import { NextResponse } from 'next/server'
import { getSupportedInlinePlatforms } from '@/lib/cron/fetchers'
import {
  createSupabaseAdmin,
  getSupabaseEnv,
} from '@/lib/cron/utils'
import { logger } from '@/lib/logger'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { connectorRegistry, initializeConnectors } from '@/lib/connectors/registry'
import { runConnectorBatch } from '@/lib/connectors/connector-db-adapter'
import { SOURCE_TO_CONNECTOR_MAP } from '@/lib/constants/exchanges'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX US geo-blocking
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min (Pro plan)

type Params = { params: Promise<{ platform: string }> }

function isVercelCronAuthorized(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret && process.env.NODE_ENV === 'development') return true
  if (!cronSecret) return false
  return authHeader === `Bearer ${cronSecret}`
}

export async function GET(request: Request, { params }: Params) {
  const { platform } = await params
  const startTime = Date.now()

  try {
    // 1) Auth
    if (!isVercelCronAuthorized(request)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    // 2) Verify env
    const { url, serviceKey } = getSupabaseEnv()
    if (!url || !serviceKey) {
      return NextResponse.json(
        { error: 'Supabase environment variables missing' },
        { status: 500 }
      )
    }

    const supabase = createSupabaseAdmin()
    if (!supabase) {
      return NextResponse.json({ error: 'Failed to create Supabase client' }, { status: 500 })
    }

    // 3) Initialize and find connector
    await initializeConnectors()

    const mapping = SOURCE_TO_CONNECTOR_MAP[platform]
    const connector = mapping
      ? await connectorRegistry.getOrInit(
          mapping.platform as import('@/lib/types/leaderboard').LeaderboardPlatform,
          mapping.marketType as import('@/lib/types/leaderboard').MarketType
        )
      : null

    if (!connector) {
      return NextResponse.json(
        { error: `No connector for platform: ${platform}`, supported: getSupportedInlinePlatforms() },
        { status: 400 }
      )
    }

    // 4) Execute via ConnectorRegistry
    const result = await runConnectorBatch(connector, {
      supabase,
      windows: ['7d', '30d', '90d'],
      sourceOverride: platform,
    })

    // 5) Record pipeline metrics
    const hasErrors = Object.values(result.periods).some((p) => p.error)
    const totalSaved = Object.values(result.periods).reduce((sum, p) => sum + (p.saved || 0), 0)

    await recordFetchResult(supabase, result.source, {
      success: !hasErrors,
      durationMs: result.duration,
      recordCount: totalSaved,
      error: hasErrors
        ? Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
        : undefined,
      metadata: { periods: result.periods },
    })

    // 6) Return result
    return NextResponse.json({
      ok: !hasErrors && totalSaved > 0,
      platform: result.source,
      ran_at: new Date().toISOString(),
      duration: result.duration,
      periods: result.periods,
      write_consistency: result.write_consistency,
    })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.apiError(`/api/cron/fetch-traders/${platform}`, error, { platform })

    // Record error metric
    try {
      const supabase = createSupabaseAdmin()
      if (supabase) {
        await recordFetchResult(supabase, platform, {
          success: false,
          durationMs: Date.now() - startTime,
          recordCount: 0,
          error: msg,
        })
      }
    } catch { /* ignore metric recording failures */ }

    return NextResponse.json(
      { ok: false, platform, error: msg },
      { status: 500 }
    )
  }
}

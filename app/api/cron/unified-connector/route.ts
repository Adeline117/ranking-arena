/**
 * Unified Connector Cron Endpoint
 * 
 * 统一的数据采集 endpoint，支持所有平台
 * 
 * Usage:
 *   GET /api/cron/unified-connector?platform=hyperliquid&window=90d
 *   GET /api/cron/unified-connector?platform=binance&window=30d
 *   GET /api/cron/unified-connector?platform=all (run all platforms)
 * 
 * Query params:
 *   - platform: Platform name (hyperliquid, binance, okx, etc.) or 'all'
 *   - window: Ranking window (7d, 30d, 90d) - default 90d
 *   - page: Page number for pagination
 *   - pageSize: Records per page
 *   - dryRun: Test mode, don't save to DB
 */

import { NextRequest, NextResponse } from 'next/server'
import { ConnectorRunner, getAllConnectorStatuses, runConnectorsBatch } from '@/lib/connectors/connector-runner'
import { HyperliquidConnector } from '@/lib/connectors/hyperliquid'
import { dataLogger } from '@/lib/utils/logger'
import type { RankingWindow } from '@/lib/types/leaderboard'

// ============================================
// Platform Registry
// ============================================

/**
 * Platform connectors registry
 * Add new platforms here
 */
const PLATFORM_CONNECTORS = {
  hyperliquid: () => new HyperliquidConnector(),
  // TODO: Add more platforms as they are migrated
  // binance: () => new BinanceFuturesConnector(),
  // okx: () => new OKXFuturesConnector(),
  // bitget: () => new BitgetFuturesConnector(),
  // htx: () => new HTXFuturesConnector(),
  // gmx: () => new GMXConnector(),
  // dydx: () => new dYdXConnector(),
  // gains: () => new GainsConnector(),
  // aevo: () => new AevoConnector(),
  // drift: () => new DriftConnector(),
  // jupiter: () => new JupiterPerpsConnector(),
} as const

type SupportedPlatform = keyof typeof PLATFORM_CONNECTORS

// ============================================
// Main Handler
// ============================================

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const platform = searchParams.get('platform') || 'all'
  const window = (searchParams.get('window') || '90d') as RankingWindow
  const page = parseInt(searchParams.get('page') || '1')
  const pageSize = parseInt(searchParams.get('pageSize') || '100')
  const dryRun = searchParams.get('dryRun') === 'true'

  try {
    // Verify authorization (Vercel cron secret)
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Handle 'all' platforms
    if (platform === 'all') {
      return await runAllPlatforms({ window, page, pageSize, dryRun })
    }

    // Handle single platform
    if (!isPlatformSupported(platform)) {
      return NextResponse.json(
        {
          error: 'Unsupported platform',
          supported: Object.keys(PLATFORM_CONNECTORS),
        },
        { status: 400 }
      )
    }

    return await runSinglePlatform(platform, { window, page, pageSize, dryRun })

  } catch (error) {
    dataLogger.error('[UnifiedConnector] Cron 执行失败:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

// ============================================
// Single Platform Execution
// ============================================

async function runSinglePlatform(
  platform: SupportedPlatform,
  params: {
    window: RankingWindow
    page: number
    pageSize: number
    dryRun: boolean
  }
) {
  const startTime = Date.now()

  dataLogger.info(`[UnifiedConnector] 开始执行: ${platform}`, params)

  // 1. Create connector instance
  const connectorFactory = PLATFORM_CONNECTORS[platform]
  const connector = connectorFactory()

  // 2. Wrap in runner
  const runner = new ConnectorRunner(connector, {
    platform,
    enableAlerts: !params.dryRun, // Disable alerts in dry-run mode
  })

  // 3. Execute
  const result = await runner.execute({
    window: params.window,
    page: params.page,
    pageSize: params.pageSize,
  })

  // 4. Get status from Redis
  const status = await runner.getStatus()

  const response = {
    platform,
    params,
    result,
    status,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }

  dataLogger.info(`[UnifiedConnector] 执行完成: ${platform}`, {
    success: result.success,
    recordsProcessed: result.recordsProcessed,
  })

  return NextResponse.json(response)
}

// ============================================
// All Platforms Execution
// ============================================

async function runAllPlatforms(params: {
  window: RankingWindow
  page: number
  pageSize: number
  dryRun: boolean
}) {
  const startTime = Date.now()
  const platforms = Object.keys(PLATFORM_CONNECTORS) as SupportedPlatform[]

  dataLogger.info('[UnifiedConnector] 批量执行所有平台:', { count: platforms.length })

  // 1. Create runners for all platforms
  const runners = platforms.map(platform => {
    const connectorFactory = PLATFORM_CONNECTORS[platform]
    const connector = connectorFactory()

    return {
      runner: new ConnectorRunner(connector, {
        platform,
        enableAlerts: !params.dryRun,
      }),
      params: {
        window: params.window,
        page: params.page,
        pageSize: params.pageSize,
      },
    }
  })

  // 2. Run in parallel batches
  const { results, summary } = await runConnectorsBatch(runners, {
    maxConcurrent: 3, // Run 3 platforms at a time
    continueOnError: true,
  })

  // 3. Get all statuses
  const statuses = await getAllConnectorStatuses(platforms)

  // 4. Build response
  const response = {
    summary: {
      ...summary,
      platforms: platforms.length,
      successRate: `${((summary.success / summary.total) * 100).toFixed(1)}%`,
    },
    results: results.map((result, i) => ({
      platform: platforms[i],
      success: result.success,
      recordsProcessed: result.recordsProcessed,
      durationMs: result.durationMs,
      errors: result.errors,
    })),
    statuses,
    params,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }

  dataLogger.info('[UnifiedConnector] 批量执行完成:', response.summary)

  return NextResponse.json(response)
}

// ============================================
// Status Endpoint
// ============================================

/**
 * GET /api/cron/unified-connector/status
 * Get status for all connectors
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const action = body.action

    if (action === 'status') {
      const platforms = Object.keys(PLATFORM_CONNECTORS) as SupportedPlatform[]
      const statuses = await getAllConnectorStatuses(platforms)

      return NextResponse.json({
        platforms: platforms.length,
        statuses,
        timestamp: new Date().toISOString(),
      })
    }

    return NextResponse.json(
      { error: 'Unknown action' },
      { status: 400 }
    )

  } catch (error) {
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

// ============================================
// Helpers
// ============================================

function isPlatformSupported(platform: string): platform is SupportedPlatform {
  return platform in PLATFORM_CONNECTORS
}

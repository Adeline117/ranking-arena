/**
 * Dynamic Cron Route for Platform Data Refresh
 *
 * DEPRECATED (2026-05): All platform fetching is now handled by
 * /api/cron/batch-fetch-traders via the Connector framework.
 *
 * This legacy route used hardcoded fetcher functions with dead API endpoints
 * (Gains /leaderboard 404, GMX The Graph DNS dead, HTX old domain, Hyperliquid 422).
 * These hung in Edge Runtime, got killed at 30s, and left dangling "running"
 * pipeline_logs entries that the health monitor reported as stuck.
 *
 * Now returns 410 Gone immediately without starting a PipelineLogger,
 * preventing ghost "stuck" entries.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

export async function GET(request: NextRequest, { params }: { params: { platform: string } }) {
  const pathname = request.nextUrl.pathname
  const platform = pathname.split('/').filter(Boolean).pop() || params.platform

  if (platform === 'health-check') {
    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'ranking-arena',
    })
  }

  return NextResponse.json(
    {
      error: 'DEPRECATED: Use /api/cron/batch-fetch-traders instead.',
      platform,
    },
    { status: 410 }
  )
}

export async function POST(request: NextRequest, { params }: { params: { platform: string } }) {
  const pathname = request.nextUrl.pathname
  const platform = pathname.split('/').filter(Boolean).pop() || params.platform

  return NextResponse.json(
    {
      success: false,
      platform,
      error:
        'DEPRECATED: Use /api/cron/batch-fetch-traders instead. This route has been retired since 2026-05.',
    },
    { status: 410 }
  )
}

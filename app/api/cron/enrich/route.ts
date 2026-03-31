/**
 * Independent Enrichment Endpoint (manual use only)
 *
 * NOT scheduled in vercel.json — use /api/cron/batch-enrich for production.
 * Thin wrapper around runEnrichment() for direct API access / debugging.
 * Core logic lives in lib/cron/enrichment-runner.ts (shared with batch-enrich).
 *
 * Query params:
 * - platform: Filter by platform (e.g., binance_futures, bybit, okx_futures)
 * - period: Filter by period (7D, 30D, 90D)
 * - limit: Max traders to enrich per platform (default: 50)
 * - offset: Skip N traders (for pagination)
 */

import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { runEnrichment, ENRICHMENT_PLATFORM_CONFIGS, NO_ENRICHMENT_PLATFORMS } from '@/lib/cron/enrichment-runner'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const preferredRegion = 'hnd1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request) {
  return handleEnrichment(req)
}

export async function POST(req: Request) {
  return handleEnrichment(req)
}

async function handleEnrichment(req: Request) {
  // Authorize
  const secret = env.CRON_SECRET
  if (!secret) {
    logger.error('[enrich] CRON_SECRET not configured')
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Parse params
  const url = new URL(req.url)
  const platformParam = url.searchParams.get('platform')
  const period = url.searchParams.get('period') || '90D'
  const limit = parseInt(url.searchParams.get('limit') || '50')
  const offset = parseInt(url.searchParams.get('offset') || '0')

  // Allow NO_ENRICHMENT_PLATFORMS - runEnrichment will handle them gracefully
  if (platformParam && !(platformParam in ENRICHMENT_PLATFORM_CONFIGS) && !NO_ENRICHMENT_PLATFORMS.has(platformParam)) {
    return NextResponse.json({
      error: 'Invalid platform',
      supported: Object.keys(ENRICHMENT_PLATFORM_CONFIGS),
    }, { status: 400 })
  }

  if (!platformParam) {
    // Running without platform param — enrich all
    return NextResponse.json({ error: 'platform param required for direct call' }, { status: 400 })
  }

  // NO_ENRICHMENT_PLATFORMS are handled inside runEnrichment with proper pipeline_logs
  // Don't early-return here - let runEnrichment handle it to ensure consistent logging

  try {
    const result = await runEnrichment({ platform: platformParam, period, limit, offset })
    return NextResponse.json(result, { status: result.ok ? 200 : 207 })
  } catch (error) {
    logger.error('[enrich] Unexpected error', { platform: platformParam, period }, error)
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    }, { status: 500 })
  }
}

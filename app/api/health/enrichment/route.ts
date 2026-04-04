/**
 * Enrichment Coverage Health API
 *
 * GET /api/health/enrichment
 * Returns per-platform enrichment coverage stats:
 *   - total traders (in leaderboard_ranks)
 *   - enriched traders (have equity curve data)
 *   - coverage percentage
 *
 * Auth: Requires CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'
import { getSupportedPlatforms } from '@/lib/cron/fetchers'
import {
  ENRICHMENT_PLATFORM_CONFIGS,
  NO_ENRICHMENT_PLATFORMS,
} from '@/lib/cron/enrichment-runner'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function verifyAuth(req: NextRequest): boolean {
  const auth = req.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret) return false
  return auth === `Bearer ${cronSecret}`
}

interface PlatformEnrichmentStats {
  platform: string
  totalTraders: number
  enrichedTraders: number
  coveragePct: number
  hasEnrichmentConfig: boolean
  isNoEnrichment: boolean
  lastEnrichmentAt: string | null
}

export async function GET(req: NextRequest) {
  if (!verifyAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const deadSet = new Set<string>([...DEAD_BLOCKED_PLATFORMS])
  const activePlatforms = getSupportedPlatforms().filter(p => !deadSet.has(p))

  const period = req.nextUrl.searchParams.get('period') || '90D'

  const platformStats: PlatformEnrichmentStats[] = []

  // Query all platforms in parallel
  const checks = activePlatforms.map(async (platform): Promise<PlatformEnrichmentStats> => {
    const hasConfig = platform in ENRICHMENT_PLATFORM_CONFIGS
    const isNoEnrich = NO_ENRICHMENT_PLATFORMS.has(platform)

    try {
      // Get total traders in leaderboard for this platform+period
      // and count of traders with equity curve data (enriched)
      const [totalRes, enrichedRes, lastEnrichRes] = await Promise.all([
        supabase
          .from('leaderboard_ranks')
          .select('source_trader_id', { count: 'exact', head: true })
          .eq('source', platform)
          .eq('season_id', period),
        // Count distinct traders with equity curve data
        supabase
          .from('trader_equity_curve')
          .select('source_trader_id', { count: 'exact', head: true })
          .eq('source', platform)
          .eq('period', period),
        // Get latest enrichment timestamp
        supabase
          .from('trader_equity_curve')
          .select('captured_at')
          .eq('source', platform)
          .eq('period', period)
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])

      // Check for query errors — don't let null count masquerade as "0 traders"
      if (totalRes.error) throw new Error(`leaderboard_ranks count failed: ${totalRes.error.message}`)
      if (enrichedRes.error) throw new Error(`trader_equity_curve count failed: ${enrichedRes.error.message}`)
      const totalTraders = totalRes.count ?? 0
      const enrichedTraders = enrichedRes.count ?? 0
      const coveragePct = totalTraders > 0 ? Math.round((enrichedTraders / totalTraders) * 1000) / 10 : 0
      const lastEnrichmentAt = lastEnrichRes.data?.captured_at || null

      return {
        platform,
        totalTraders,
        enrichedTraders,
        coveragePct,
        hasEnrichmentConfig: hasConfig,
        isNoEnrichment: isNoEnrich,
        lastEnrichmentAt,
      }
    } catch {
      return {
        platform,
        totalTraders: 0,
        enrichedTraders: 0,
        coveragePct: 0,
        hasEnrichmentConfig: hasConfig,
        isNoEnrichment: isNoEnrich,
        lastEnrichmentAt: null,
      }
    }
  })

  const results = await Promise.all(checks)
  platformStats.push(...results)
  platformStats.sort((a, b) => b.totalTraders - a.totalTraders)

  // Calculate overall stats
  const totalTraders = platformStats.reduce((sum, p) => sum + p.totalTraders, 0)
  const totalEnriched = platformStats.reduce((sum, p) => sum + p.enrichedTraders, 0)
  const overallCoverage = totalTraders > 0 ? Math.round((totalEnriched / totalTraders) * 1000) / 10 : 0

  // Enrichable platforms only (have config, not in NO_ENRICHMENT list)
  const enrichable = platformStats.filter(p => p.hasEnrichmentConfig && !p.isNoEnrichment)
  const enrichableTotal = enrichable.reduce((sum, p) => sum + p.totalTraders, 0)
  const enrichableEnriched = enrichable.reduce((sum, p) => sum + p.enrichedTraders, 0)
  const enrichableCoverage = enrichableTotal > 0 ? Math.round((enrichableEnriched / enrichableTotal) * 1000) / 10 : 0

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    period,
    summary: {
      totalPlatforms: platformStats.length,
      enrichablePlatforms: enrichable.length,
      noEnrichmentPlatforms: platformStats.filter(p => p.isNoEnrichment).length,
      totalTraders,
      totalEnriched,
      overallCoveragePct: overallCoverage,
      enrichableCoveragePct: enrichableCoverage,
    },
    platforms: platformStats,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

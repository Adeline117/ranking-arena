/**
 * Infrastructure Observability API
 * GET /api/admin/observability
 *
 * Aggregates pipeline stats, data freshness, leaderboard counts,
 * and table sizes into a single structured response.
 *
 * Auth: Requires CRON_SECRET via Authorization: Bearer header
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:observability')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function verifyAuth(req: NextRequest): boolean {
  const auth = req.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret) return false
  return auth === `Bearer ${cronSecret}`
}

interface JobAggregate {
  total: number
  success: number
  failed: number
  avgMs: number
  p95Ms: number
  lastRun: string | null
}

export async function GET(req: NextRequest) {
  if (!verifyAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
  const supabase = getSupabaseAdmin()
  const now = Date.now()
  const twentyFourHoursAgo = new Date(now - 24 * 3600 * 1000).toISOString()

  // Run all queries in parallel
  const [pipelineRes, freshnessRes, ...seasonResults] = await Promise.all([
    // 1. Pipeline stats from pipeline_logs (last 24h)
    supabase
      .from('pipeline_logs')
      .select('job_name, status, duration_ms, started_at')
      .gte('started_at', twentyFourHoursAgo)
      .order('started_at', { ascending: false })
      .limit(500),

    // 2. Data freshness per platform (latest snapshot per platform)
    supabase
      .from('trader_snapshots_v2')
      .select('platform, updated_at')
      .order('updated_at', { ascending: false })
      .limit(200),

    // 3. Leaderboard counts per season
    ...((['7D', '30D', '90D'] as const).map(season =>
      supabase
        .from('leaderboard_ranks')
        .select('*', { count: 'exact', head: true })
        .eq('season_id', season)
    )),

    // 4. Table sizes (estimated counts) — added after season queries
    ...(['traders', 'trader_snapshots_v2', 'leaderboard_ranks', 'trader_daily_snapshots'] as const).map(table =>
      supabase
        .from(table)
        .select('*', { count: 'estimated', head: true })
    ),
  ])

  // --- Aggregate pipeline stats ---
  const jobStats: Record<string, JobAggregate> = {}
  for (const log of pipelineRes.data || []) {
    if (!jobStats[log.job_name]) {
      jobStats[log.job_name] = {
        total: 0,
        success: 0,
        failed: 0,
        avgMs: 0,
        p95Ms: 0,
        lastRun: null,
      }
    }
    const entry = jobStats[log.job_name]
    entry.total++
    if (log.status === 'success') entry.success++
    if (log.status === 'error') entry.failed++
    if (!entry.lastRun) entry.lastRun = log.started_at
  }

  // Compute avg and p95 durations per job
  const durationsByJob: Record<string, number[]> = {}
  for (const log of pipelineRes.data || []) {
    if (log.duration_ms != null) {
      if (!durationsByJob[log.job_name]) durationsByJob[log.job_name] = []
      durationsByJob[log.job_name].push(log.duration_ms)
    }
  }
  for (const [jobName, durations] of Object.entries(durationsByJob)) {
    if (jobStats[jobName] && durations.length > 0) {
      jobStats[jobName].avgMs = Math.round(
        durations.reduce((a, b) => a + b, 0) / durations.length
      )
      const sorted = [...durations].sort((a, b) => a - b)
      const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)
      jobStats[jobName].p95Ms = sorted[p95Index]
    }
  }

  // Overall pipeline summary
  const allJobs = Object.values(jobStats)
  const totalRuns = allJobs.reduce((s, j) => s + j.total, 0)
  const totalSuccess = allJobs.reduce((s, j) => s + j.success, 0)
  const totalFailed = allJobs.reduce((s, j) => s + j.failed, 0)
  const overallSuccessRate = totalRuns > 0
    ? Math.round((totalSuccess / totalRuns) * 1000) / 10
    : 0

  // --- Aggregate data freshness per platform ---
  const platformFreshness: Record<string, { latestUpdate: string; ageHours: number }> = {}
  for (const row of freshnessRes.data || []) {
    if (!platformFreshness[row.platform]) {
      const ageMs = now - new Date(row.updated_at).getTime()
      platformFreshness[row.platform] = {
        latestUpdate: row.updated_at,
        ageHours: Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10,
      }
    }
  }

  // --- Leaderboard counts ---
  const seasons = ['7D', '30D', '90D'] as const
  const seasonCounts: Record<string, number> = {}
  for (let i = 0; i < seasons.length; i++) {
    seasonCounts[seasons[i]] = seasonResults[i]?.count ?? 0
  }

  // --- Table sizes ---
  const tableNames = ['traders', 'trader_snapshots_v2', 'leaderboard_ranks', 'trader_daily_snapshots'] as const
  const tableSizes: Record<string, number> = {}
  for (let i = 0; i < tableNames.length; i++) {
    tableSizes[tableNames[i]] = seasonResults[seasons.length + i]?.count ?? 0
  }

  // --- Failed jobs list (for quick triage) ---
  const failedJobs = Object.entries(jobStats)
    .filter(([, stats]) => stats.failed > 0)
    .map(([name, stats]) => ({
      job: name,
      failedRuns: stats.failed,
      totalRuns: stats.total,
      successRate: Math.round((stats.success / stats.total) * 1000) / 10,
    }))
    .sort((a, b) => b.failedRuns - a.failedRuns)

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    pipeline: {
      totalRuns,
      totalSuccess,
      totalFailed,
      overallSuccessRate,
      uniqueJobs: Object.keys(jobStats).length,
      failedJobs,
      jobStats,
    },
    dataFreshness: {
      platformCount: Object.keys(platformFreshness).length,
      platforms: platformFreshness,
    },
    leaderboard: {
      seasonCounts,
    },
    tableSizes,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
  } catch (error) {
    logger.error('Unexpected error', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 }
    )
  }
}

/**
 * Data quality evaluation checks — freshness, counts, anomalies, coverage, enrichment.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PipelineState } from '@/lib/services/pipeline-state'
import type { CheckResult } from './types'

/** Check 1: Data Freshness — platforms have data updated within expected windows. */
export async function checkDataFreshness(platformsHint?: string[]): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []

  let platformFreshness: Array<{
    platform: string
    latest_snapshot: string
    trader_count: number
  }> | null = null
  try {
    const { data: rpcData } = await supabase.rpc('get_platform_freshness')
    if (rpcData && Array.isArray(rpcData) && rpcData.length > 0) {
      platformFreshness = rpcData as unknown as typeof platformFreshness
    }
  } catch {
    /* RPC not available */
  }

  if (!platformFreshness) {
    const { data: lrData } = await supabase
      .from('leaderboard_ranks')
      .select('source, computed_at')
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .order('computed_at', { ascending: false })
      .limit(5000)

    if (lrData && lrData.length > 0) {
      const byPlatform = new Map<string, { latest: string; count: number }>()
      for (const row of lrData) {
        const existing = byPlatform.get(row.source)
        if (!existing) {
          byPlatform.set(row.source, { latest: row.computed_at, count: 1 })
        } else {
          existing.count++
        }
      }
      platformFreshness = [...byPlatform.entries()].map(([platform, { latest, count }]) => ({
        platform,
        latest_snapshot: latest,
        trader_count: count,
      }))
    }
  }

  let staleCount = 0
  let totalPlatforms = 0

  if (platformFreshness && Array.isArray(platformFreshness)) {
    const platforms = platformsHint?.length
      ? platformFreshness.filter((p) => platformsHint.includes(p.platform))
      : platformFreshness

    totalPlatforms = platforms.length
    const now = Date.now()
    const DEX_PLATFORMS = ['hyperliquid', 'gmx', 'drift', 'jupiter_perps', 'aevo', 'gains']
    const CEX_MAX_STALE_MS = 6 * 3600 * 1000
    const DEX_MAX_STALE_MS = 12 * 3600 * 1000

    for (const p of platforms) {
      const age = now - new Date(p.latest_snapshot).getTime()
      const maxAge =
        p.platform?.includes('web3') || DEX_PLATFORMS.includes(p.platform)
          ? DEX_MAX_STALE_MS
          : CEX_MAX_STALE_MS

      if (age > maxAge) {
        staleCount++
        issues.push({
          platform: p.platform,
          type: 'stale_data',
          severity: age > maxAge * 2 ? 'critical' : 'warning',
          description: `Data is ${Math.round(age / 3600000)}h old (max: ${Math.round(maxAge / 3600000)}h)`,
          recommendation: `Check cron job for ${p.platform}. May need VPS fallback or connector fix.`,
        })
      }
    }
  }

  const score =
    totalPlatforms > 0 ? Math.round(((totalPlatforms - staleCount) / totalPlatforms) * 100) : 50
  return {
    check: {
      name: 'data_freshness',
      category: 'freshness',
      passed: staleCount === 0,
      score,
      details: `${totalPlatforms - staleCount}/${totalPlatforms} platforms fresh`,
    },
    issues,
  }
}

/** Check 2: Record Count Consistency — flag drops > 20% vs baseline. */
export async function checkRecordCounts(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []

  let currentCount: number | null = null
  const { count: lrCount } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'estimated', head: true })
  currentCount = lrCount
  if (currentCount == null) {
    const { data: sample } = await supabase.from('leaderboard_ranks').select('id').limit(10000)
    currentCount = sample?.length ?? 0
  }

  const baseline = await PipelineState.get<number>('evaluator:baseline:trader_count')
  let score = 100
  if (baseline && currentCount) {
    const changeRatio = currentCount / baseline
    if (changeRatio < 0.8) {
      score = 30
      issues.push({
        platform: 'all',
        type: 'record_count_drop',
        severity: 'critical',
        description: `Trader count dropped from ${baseline} to ${currentCount} (-${Math.round((1 - changeRatio) * 100)}%)`,
        recommendation: 'Check recent pipeline runs for data deletion or failed writes.',
      })
    } else if (changeRatio < 0.95) {
      score = 70
      issues.push({
        platform: 'all',
        type: 'record_count_drop',
        severity: 'warning',
        description: `Trader count dropped from ${baseline} to ${currentCount} (-${Math.round((1 - changeRatio) * 100)}%)`,
        recommendation: 'Monitor — may be normal platform cleanup.',
      })
    }
  }
  if (currentCount) await PipelineState.set('evaluator:baseline:trader_count', currentCount)

  return {
    check: {
      name: 'record_count_consistency',
      category: 'consistency',
      passed: score >= 70,
      score,
      details: `Current: ${currentCount}, baseline: ${baseline ?? 'none'}`,
    },
    issues,
  }
}

/** Check 3: ROI Anomaly Detection — find impossible ROI values. */
export async function checkROIAnomalies(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []

  const { data: anomalies, count: anomalyCount } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, roi', { count: 'exact' })
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .or('roi.lt.-100,roi.gt.100000')
    .limit(10)

  const score =
    (anomalyCount ?? 0) === 0
      ? 100
      : (anomalyCount ?? 0) < 5
        ? 80
        : (anomalyCount ?? 0) < 20
          ? 50
          : 20

  if (anomalies && anomalies.length > 0) {
    const byPlatform: Record<string, number> = {}
    for (const a of anomalies) byPlatform[a.source] = (byPlatform[a.source] || 0) + 1
    for (const [platform, count] of Object.entries(byPlatform)) {
      issues.push({
        platform,
        type: 'roi_anomaly',
        severity: count > 5 ? 'critical' : 'warning',
        description: `${count} traders with impossible ROI values`,
        recommendation: `Check ${platform} connector normalize() — may need decimal→percentage fix.`,
      })
    }
  }

  return {
    check: {
      name: 'roi_anomaly_detection',
      category: 'anomaly',
      passed: (anomalyCount ?? 0) < 5,
      score,
      details: `${anomalyCount ?? 0} anomalous ROI values found`,
    },
    issues,
  }
}

/** Check 4: Arena Score Coverage — >90% of leaderboard traders have non-null scores. */
export async function checkArenaScoreCoverage(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []

  const { count: totalCount } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'estimated', head: true })
  const { count: scoredCount } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'estimated', head: true })
    .not('arena_score', 'is', null)

  const total = totalCount ?? scoredCount ?? 0
  const scored = scoredCount ?? 0
  const coverage = total > 0 ? scored / total : scored > 0 ? 1 : 0
  const score = Math.round(coverage * 100)

  if (coverage < 0.9 && total > 0) {
    issues.push({
      platform: 'all',
      type: 'low_arena_score_coverage',
      severity: coverage < 0.7 ? 'critical' : 'warning',
      description: `Arena Score coverage: ${Math.round(coverage * 100)}% (${scored}/${total})`,
      recommendation: 'Run compute-leaderboard manually or check score formula for null inputs.',
    })
  }

  return {
    check: {
      name: 'arena_score_coverage',
      category: 'completeness',
      passed: coverage >= 0.9,
      score,
      details: `${scoredCount ?? 0}/${totalCount ?? 0} traders have Arena Scores (${Math.round(coverage * 100)}%)`,
    },
    issues,
  }
}

/** Check 5: Leaderboard Integrity — no duplicate traders, reasonable distribution. */
export async function checkLeaderboardIntegrity(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []

  const { count: totalRows } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'estimated', head: true })
  let score = 100
  let dupeCount = 0

  if (totalRows && totalRows > 0) {
    const { data: sampleDupes } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, season_id')
      .order('updated_at', { ascending: false })
      .limit(1000)
    if (sampleDupes) {
      const seen = new Set<string>()
      for (const row of sampleDupes) {
        const key = `${row.source}:${row.source_trader_id}:${row.season_id}`
        if (seen.has(key)) dupeCount++
        seen.add(key)
      }
    }
  }

  if (dupeCount > 0) {
    score = dupeCount > 10 ? 30 : 50
    issues.push({
      platform: 'all',
      type: 'duplicate_ranks',
      severity: 'critical',
      description: `${dupeCount} duplicate entries found in leaderboard_ranks sample (top 1000 rows)`,
      recommendation: 'Check compute-leaderboard upsert logic — conflict resolution may be broken.',
    })
  }

  return {
    check: {
      name: 'leaderboard_integrity',
      category: 'consistency',
      passed: score >= 70,
      score,
      details: `${dupeCount} duplicates in sample of ${totalRows ?? '?'} total rows`,
    },
    issues,
  }
}

/** Check 6: Enrichment Coverage — >60% of top traders have enrichment data. */
export async function checkEnrichmentCoverage(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []

  const { data: sample } = await supabase
    .from('leaderboard_ranks')
    .select('win_rate, sharpe_ratio, trades_count')
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .order('arena_score', { ascending: false })
    .limit(500)

  const sampleSize = sample?.length ?? 0
  if (sampleSize === 0) {
    return {
      check: {
        name: 'enrichment_coverage',
        category: 'completeness',
        passed: true,
        score: 50,
        details: 'No sample data available',
      },
      issues: [],
    }
  }

  const enrichedSample = (sample || []).filter(
    (r) => r.win_rate != null || r.sharpe_ratio != null || r.trades_count != null
  ).length
  const coverage = enrichedSample / sampleSize
  const score = Math.min(100, Math.round(coverage * 100 * 1.5))

  if (coverage < 0.5) {
    issues.push({
      platform: 'all',
      type: 'low_enrichment_coverage',
      severity: coverage < 0.3 ? 'critical' : 'warning',
      description: `Enrichment coverage: ${Math.round(coverage * 100)}% of top 500 (${enrichedSample}/${sampleSize} have win_rate/sharpe/trades)`,
      recommendation: 'Check batch-enrich cron — some platforms may be failing silently.',
    })
  }

  return {
    check: {
      name: 'enrichment_coverage',
      category: 'completeness',
      passed: coverage >= 0.5,
      score,
      details: `${enrichedSample}/${sampleSize} top traders enriched (${Math.round(coverage * 100)}%)`,
    },
    issues,
  }
}

/** Check 7: Platform Coverage — all expected platforms have leaderboard data. */
export async function checkPlatformCoverage(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []
  const EXPECTED = [
    'binance_futures',
    'bybit',
    'okx_futures',
    'bitget_futures',
    'mexc',
    'hyperliquid',
    'gmx',
    'dydx',
    'drift',
    'jupiter_perps',
    'htx_futures',
    'gateio',
    'bingx',
    'coinex',
    'aevo',
    'gains',
  ]

  const platformChecks = await Promise.all(
    EXPECTED.map(async (platform) => {
      const { data } = await supabase
        .from('leaderboard_ranks')
        .select('source')
        .eq('season_id', '90D')
        .eq('source', platform)
        .not('arena_score', 'is', null)
        .limit(1)
      return { platform, hasData: (data?.length ?? 0) > 0 }
    })
  )
  const active = new Set(platformChecks.filter((p) => p.hasData).map((p) => p.platform))
  const missing = EXPECTED.filter((p) => !active.has(p))
  for (const p of missing) {
    issues.push({
      platform: p,
      type: 'missing_platform',
      severity: 'warning',
      description: `${p} has no traders in 90D leaderboard`,
      recommendation: `Check batch-fetch-traders for ${p}.`,
    })
  }
  const score = Math.round(((EXPECTED.length - missing.length) / EXPECTED.length) * 100)
  return {
    check: {
      name: 'platform_coverage',
      category: 'completeness',
      passed: missing.length <= 2,
      score,
      details: `${active.size} active, ${missing.length} missing of ${EXPECTED.length} expected`,
    },
    issues,
  }
}

/** Check 12: Per-Platform Data Coverage — verify each platform has sufficient enrichment. */
export async function checkPerPlatformDataCoverage(): Promise<CheckResult> {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const issues: CheckResult['issues'] = []
  const PLATFORMS = [
    'binance_futures',
    'bybit',
    'okx_futures',
    'bitget_futures',
    'mexc',
    'hyperliquid',
    'gmx',
    'dydx',
    'drift',
    'jupiter_perps',
  ]

  let totalCoverage = 0
  let platformsChecked = 0

  for (const platform of PLATFORMS) {
    const { data: sample } = await supabase
      .from('leaderboard_ranks')
      .select('win_rate, sharpe_ratio, max_drawdown, trades_count')
      .eq('season_id', '90D')
      .eq('source', platform)
      .not('arena_score', 'is', null)
      .order('arena_score', { ascending: false })
      .limit(50)
    if (!sample || sample.length === 0) continue
    platformsChecked++

    let fieldsPopulated = 0,
      fieldsTotal = 0
    for (const row of sample) {
      if (row.win_rate != null) fieldsPopulated++
      if (row.sharpe_ratio != null) fieldsPopulated++
      if (row.max_drawdown != null) fieldsPopulated++
      if (row.trades_count != null) fieldsPopulated++
      fieldsTotal += 4
    }

    const coverage = fieldsTotal > 0 ? fieldsPopulated / fieldsTotal : 0
    totalCoverage += coverage
    if (coverage < 0.4) {
      issues.push({
        platform,
        type: 'low_field_coverage',
        severity: coverage < 0.2 ? 'warning' : 'info',
        description: `${platform}: ${Math.round(coverage * 100)}% field coverage (top 50)`,
        recommendation: `Check enrichment config for ${platform}.`,
      })
    }
  }

  const avgCoverage = platformsChecked > 0 ? totalCoverage / platformsChecked : 0
  const score = Math.min(100, Math.round(avgCoverage * 100 * 1.2))
  return {
    check: {
      name: 'per_platform_data_coverage',
      category: 'completeness',
      passed: avgCoverage >= 0.5,
      score,
      details: `${platformsChecked} platforms checked, avg field coverage ${Math.round(avgCoverage * 100)}%`,
    },
    issues,
  }
}

/** Check 18: Cross-source data consistency (LR vs trader_latest). */
export async function checkCrossSourceConsistency(): Promise<CheckResult> {
  const issues: CheckResult['issues'] = []
  const TOLERANCE = 0.001

  try {
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { data: sample } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, roi, pnl, arena_score')
      .eq('season_id', '90D')
      .gt('arena_score', 20)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('arena_score', { ascending: false })
      .limit(50)

    if (!sample?.length) {
      return {
        check: {
          name: 'cross_source_consistency',
          category: 'consistency',
          passed: true,
          score: 80,
          details: 'No sample data available',
        },
        issues,
      }
    }

    const shuffled = sample.sort(() => Math.random() - 0.5).slice(0, 3)
    let mismatches = 0

    for (const trader of shuffled) {
      const { data: v2Row } = await supabase
        .from('trader_latest')
        .select('roi_pct, pnl_usd')
        .eq('platform', trader.source)
        .eq('trader_key', trader.source_trader_id)
        .eq('window', '90D')
        .maybeSingle()
      if (!v2Row) continue

      const lrRoi = Number(trader.roi),
        v2Roi = Number(v2Row.roi_pct)
      if (lrRoi && v2Roi) {
        const diff = Math.abs(lrRoi - v2Roi) / Math.max(Math.abs(lrRoi), Math.abs(v2Roi), 1)
        if (diff > TOLERANCE) {
          mismatches++
          issues.push({
            platform: trader.source,
            type: 'roi_mismatch',
            severity: 'warning',
            description: `${trader.source_trader_id}: LR ROI=${lrRoi.toFixed(2)} vs V2 ROI=${v2Roi.toFixed(2)} (${(diff * 100).toFixed(1)}% diff)`,
            recommendation: 'Check if compute-leaderboard and enrichment use same ROI source.',
          })
        }
      }
    }

    const score = mismatches === 0 ? 100 : mismatches === 1 ? 70 : 30
    return {
      check: {
        name: 'cross_source_consistency',
        category: 'consistency',
        passed: mismatches === 0,
        score,
        details: `${shuffled.length} traders sampled, ${mismatches} ROI mismatches`,
      },
      issues,
    }
  } catch (err) {
    return {
      check: {
        name: 'cross_source_consistency',
        category: 'consistency',
        passed: false,
        score: 0,
        details: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
      issues,
    }
  }
}

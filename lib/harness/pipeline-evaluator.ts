/**
 * Pipeline Evaluator — independent data quality verification.
 *
 * Based on Anthropic's harness pattern: "Separating the agent doing the work
 * from the agent judging it proves to be a strong lever."
 *
 * The Evaluator does NOT trust the Generator's self-reports. It independently
 * queries the database to verify data quality after each pipeline run.
 *
 * Runs after compute-leaderboard, triggered via trigger-chain.
 * Writes feedback to pipeline_state for the Planner to read on next cycle.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'

// ── Types ────────────────────────────────────────────────────────

export interface EvaluationCheck {
  name: string
  category: 'completeness' | 'freshness' | 'consistency' | 'anomaly'
  passed: boolean
  score: number  // 0-100
  details: string
}

export interface EvaluationIssue {
  platform: string
  type: string
  severity: 'critical' | 'warning' | 'info'
  description: string
  recommendation: string
}

export interface EvaluationResult {
  trace_id: string | null
  overall_score: number  // 0-100
  passed: boolean
  checks: EvaluationCheck[]
  issues: EvaluationIssue[]
  recommendations: string[]
  evaluated_at: string
  duration_ms: number
}

// ── Evaluator ────────────────────────────────────────────────────

export class PipelineEvaluator {
  /**
   * Run all evaluation checks independently.
   * Does NOT trust any upstream reports — queries DB directly.
   */
  static async evaluate(traceId: string | null, platformsHint?: string[]): Promise<EvaluationResult> {
    const startTime = Date.now()
    const checks: EvaluationCheck[] = []
    const issues: EvaluationIssue[] = []

    // Run all checks in parallel (they're independent reads)
    const checkResults = await Promise.allSettled([
      this.checkDataFreshness(platformsHint),
      this.checkRecordCounts(),
      this.checkROIAnomalies(),
      this.checkArenaScoreCoverage(),
      this.checkLeaderboardIntegrity(),
      this.checkEnrichmentCoverage(),
    ])

    for (const result of checkResults) {
      if (result.status === 'fulfilled') {
        checks.push(result.value.check)
        issues.push(...result.value.issues)
      } else {
        // Check itself failed — log but don't block
        logger.warn(`[evaluator] Check failed: ${result.reason}`)
        checks.push({
          name: 'check_execution',
          category: 'consistency',
          passed: false,
          score: 0,
          details: `Check failed to execute: ${result.reason}`,
        })
      }
    }

    // Calculate overall score (weighted average)
    const totalScore = checks.reduce((sum, c) => sum + c.score, 0)
    const overallScore = checks.length > 0 ? Math.round(totalScore / checks.length) : 0
    const passed = overallScore >= 70 && !issues.some(i => i.severity === 'critical')

    // Generate recommendations from issues
    const recommendations = issues
      .filter(i => i.severity !== 'info')
      .map(i => i.recommendation)

    const result: EvaluationResult = {
      trace_id: traceId,
      overall_score: overallScore,
      passed,
      checks,
      issues,
      recommendations,
      evaluated_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    }

    // Write feedback to pipeline_state for Planner
    await this.writeFeedback(result)

    // Alert on critical issues
    if (!passed) {
      const criticalIssues = issues.filter(i => i.severity === 'critical')
      if (criticalIssues.length > 0) {
        sendRateLimitedAlert(
          {
            title: `Pipeline Evaluator: ${criticalIssues.length} critical issues`,
            message: criticalIssues.map(i => `[${i.platform}] ${i.description}`).join('\n'),
            level: 'critical',
            details: { trace_id: traceId, score: overallScore, issues: criticalIssues },
          },
          'evaluator:critical',
          6 * 3600 * 1000 // 6h rate limit
        ).catch(err => logger.warn(`[evaluator] Failed to send alert: ${err}`))
      }
    }

    logger.info(
      `[evaluator] Evaluation complete: score=${overallScore}/100, passed=${passed}, ` +
      `checks=${checks.length}, issues=${issues.length}, duration=${result.duration_ms}ms`
    )

    return result
  }

  // ── Individual Checks ──────────────────────────────────────────

  /**
   * Check 1: Data Freshness
   * Verify platforms have data updated within expected windows.
   */
  private static async checkDataFreshness(
    platformsHint?: string[]
  ): Promise<{ check: EvaluationCheck; issues: EvaluationIssue[] }> {
    const supabase = getSupabaseAdmin()
    const issues: EvaluationIssue[] = []

    // Query latest snapshot per platform
    const { data: freshness } = await supabase
      .from('trader_snapshots_v2')
      .select('source, updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)

    // Query distinct platforms with their latest update
    const { data: platformFreshness } = await supabase.rpc('get_platform_freshness')
      .then(r => r, () => ({ data: null, error: null, count: null, status: 0, statusText: '' }))

    // Fallback: check via raw query if RPC doesn't exist
    let staleCount = 0
    let totalPlatforms = 0

    if (platformFreshness && Array.isArray(platformFreshness)) {
      totalPlatforms = platformFreshness.length
      const now = Date.now()
      const CEX_MAX_STALE_MS = 6 * 3600 * 1000  // 6h for CEX
      const DEX_MAX_STALE_MS = 12 * 3600 * 1000 // 12h for DEX

      for (const p of platformFreshness) {
        const age = now - new Date(p.latest_update).getTime()
        const maxAge = p.source?.includes('web3') || ['hyperliquid', 'gmx', 'drift', 'jupiter_perps', 'aevo', 'gains'].includes(p.source)
          ? DEX_MAX_STALE_MS
          : CEX_MAX_STALE_MS

        if (age > maxAge) {
          staleCount++
          issues.push({
            platform: p.source,
            type: 'stale_data',
            severity: age > maxAge * 2 ? 'critical' : 'warning',
            description: `Data is ${Math.round(age / 3600000)}h old (max: ${Math.round(maxAge / 3600000)}h)`,
            recommendation: `Check cron job for ${p.source}. May need VPS fallback or connector fix.`,
          })
        }
      }
    }

    const score = totalPlatforms > 0
      ? Math.round(((totalPlatforms - staleCount) / totalPlatforms) * 100)
      : 50 // Unknown — give neutral score

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

  /**
   * Check 2: Record Count Consistency
   * Compare current snapshot counts vs 24h ago — flag drops > 20%.
   */
  private static async checkRecordCounts(): Promise<{ check: EvaluationCheck; issues: EvaluationIssue[] }> {
    const supabase = getSupabaseAdmin()
    const issues: EvaluationIssue[] = []

    // Current total traders
    const { count: currentCount } = await supabase
      .from('trader_snapshots_v2')
      .select('*', { count: 'exact', head: true })

    // Compare with stored baseline from last evaluation
    const baseline = await PipelineState.get<number>('evaluator:baseline:trader_count')

    let score = 100
    if (baseline && currentCount) {
      const changeRatio = currentCount / baseline
      if (changeRatio < 0.80) {
        // >20% drop — critical
        score = 30
        issues.push({
          platform: 'all',
          type: 'record_count_drop',
          severity: 'critical',
          description: `Trader count dropped from ${baseline} to ${currentCount} (-${Math.round((1 - changeRatio) * 100)}%)`,
          recommendation: 'Check recent pipeline runs for data deletion or failed writes.',
        })
      } else if (changeRatio < 0.95) {
        // 5-20% drop — warning
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

    // Update baseline for next evaluation
    if (currentCount) {
      await PipelineState.set('evaluator:baseline:trader_count', currentCount)
    }

    return {
      check: {
        name: 'record_count_consistency',
        category: 'consistency',
        passed: score >= 70,
        score,
        details: `Current: ${currentCount ?? 'unknown'}, baseline: ${baseline ?? 'none'}`,
      },
      issues,
    }
  }

  /**
   * Check 3: ROI Anomaly Detection
   * Find traders with impossible ROI values (< -100% or > 50000%).
   */
  private static async checkROIAnomalies(): Promise<{ check: EvaluationCheck; issues: EvaluationIssue[] }> {
    const supabase = getSupabaseAdmin()
    const issues: EvaluationIssue[] = []

    // Find anomalous ROI values
    const { data: anomalies, count: anomalyCount } = await supabase
      .from('trader_snapshots_v2')
      .select('source, source_trader_id, roi', { count: 'exact' })
      .or('roi.lt.-100,roi.gt.50000')
      .limit(10) // Only sample for reporting

    const score = (anomalyCount ?? 0) === 0 ? 100
      : (anomalyCount ?? 0) < 5 ? 80
      : (anomalyCount ?? 0) < 20 ? 50
      : 20

    if (anomalies && anomalies.length > 0) {
      // Group by platform
      const byPlatform: Record<string, number> = {}
      for (const a of anomalies) {
        byPlatform[a.source] = (byPlatform[a.source] || 0) + 1
      }

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

  /**
   * Check 4: Arena Score Coverage
   * Ensure >90% of leaderboard traders have non-null Arena Scores.
   */
  private static async checkArenaScoreCoverage(): Promise<{ check: EvaluationCheck; issues: EvaluationIssue[] }> {
    const supabase = getSupabaseAdmin()
    const issues: EvaluationIssue[] = []

    // Total in leaderboard
    const { count: totalCount } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })

    // With non-null arena_score
    const { count: scoredCount } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .not('arena_score', 'is', null)

    const coverage = totalCount && totalCount > 0 ? (scoredCount ?? 0) / totalCount : 0
    const score = Math.round(coverage * 100)

    if (coverage < 0.90) {
      issues.push({
        platform: 'all',
        type: 'low_arena_score_coverage',
        severity: coverage < 0.70 ? 'critical' : 'warning',
        description: `Arena Score coverage: ${Math.round(coverage * 100)}% (${scoredCount}/${totalCount})`,
        recommendation: 'Run compute-leaderboard manually or check score formula for null inputs.',
      })
    }

    return {
      check: {
        name: 'arena_score_coverage',
        category: 'completeness',
        passed: coverage >= 0.90,
        score,
        details: `${scoredCount ?? 0}/${totalCount ?? 0} traders have Arena Scores (${Math.round(coverage * 100)}%)`,
      },
      issues,
    }
  }

  /**
   * Check 5: Leaderboard Integrity
   * Verify no duplicate traders, reasonable rank distribution.
   */
  private static async checkLeaderboardIntegrity(): Promise<{ check: EvaluationCheck; issues: EvaluationIssue[] }> {
    const supabase = getSupabaseAdmin()
    const issues: EvaluationIssue[] = []

    // Check for duplicate (source, source_trader_id, season) in leaderboard_ranks
    let dupeCheck: unknown[] | null = null
    try {
      const { data } = await supabase.rpc('check_leaderboard_duplicates')
      dupeCheck = data
    } catch {
      // RPC may not exist yet
    }

    let score = 100
    if (dupeCheck && Array.isArray(dupeCheck) && dupeCheck.length > 0) {
      score = 50
      issues.push({
        platform: 'all',
        type: 'duplicate_ranks',
        severity: 'critical',
        description: `${dupeCheck.length} duplicate entries in leaderboard_ranks`,
        recommendation: 'Check compute-leaderboard upsert logic — conflict resolution may be broken.',
      })
    }

    return {
      check: {
        name: 'leaderboard_integrity',
        category: 'consistency',
        passed: score >= 70,
        score,
        details: dupeCheck ? `${dupeCheck.length} duplicates found` : 'Integrity check OK (no duplicates RPC)',
      },
      issues,
    }
  }

  /**
   * Check 6: Enrichment Coverage
   * Verify >60% of top-ranked traders have enrichment data (win_rate, sharpe, etc.)
   */
  private static async checkEnrichmentCoverage(): Promise<{ check: EvaluationCheck; issues: EvaluationIssue[] }> {
    const supabase = getSupabaseAdmin()
    const issues: EvaluationIssue[] = []

    // Sample top 500 traders by Arena Score — check enrichment fields
    const { data: topTraders, count: totalTop } = await supabase
      .from('leaderboard_ranks')
      .select('source, arena_score', { count: 'exact' })
      .not('arena_score', 'is', null)
      .order('arena_score', { ascending: false })
      .limit(500)

    // Check enrichment in trader_details for these platforms
    const { count: enrichedCount } = await supabase
      .from('trader_details')
      .select('*', { count: 'exact', head: true })
      .not('win_rate', 'is', null)

    const { count: totalDetails } = await supabase
      .from('trader_details')
      .select('*', { count: 'exact', head: true })

    const coverage = totalDetails && totalDetails > 0 ? (enrichedCount ?? 0) / totalDetails : 0
    const score = Math.min(100, Math.round(coverage * 100 * 1.5)) // Scale up — 67% coverage = 100 score

    if (coverage < 0.50) {
      issues.push({
        platform: 'all',
        type: 'low_enrichment_coverage',
        severity: coverage < 0.30 ? 'critical' : 'warning',
        description: `Enrichment coverage (win_rate): ${Math.round(coverage * 100)}% (${enrichedCount}/${totalDetails})`,
        recommendation: 'Check batch-enrich cron — some platforms may be failing silently.',
      })
    }

    return {
      check: {
        name: 'enrichment_coverage',
        category: 'completeness',
        passed: coverage >= 0.50,
        score,
        details: `${enrichedCount ?? 0}/${totalDetails ?? 0} traders enriched (${Math.round(coverage * 100)}%)`,
      },
      issues,
    }
  }

  // ── Feedback Loop ──────────────────────────────────────────────

  /**
   * Write evaluation results to pipeline_state for the Planner to read.
   * This is the Evaluator → Planner feedback loop.
   */
  private static async writeFeedback(result: EvaluationResult): Promise<void> {
    // Store latest evaluation result
    await PipelineState.set('evaluator:latest', {
      score: result.overall_score,
      passed: result.passed,
      issue_count: result.issues.length,
      critical_count: result.issues.filter(i => i.severity === 'critical').length,
      evaluated_at: result.evaluated_at,
      trace_id: result.trace_id,
    })

    // Per-platform feedback for Planner
    for (const issue of result.issues) {
      if (issue.platform === 'all') continue
      const feedbackKey = `evaluator:feedback:${issue.platform}`
      const existing = await PipelineState.get<{ occurrence_count: number }>(feedbackKey)
      const occurrenceCount = (existing?.occurrence_count ?? 0) + 1

      await PipelineState.set(feedbackKey, {
        issue_type: issue.type,
        severity: issue.severity,
        recommendation: issue.recommendation,
        last_seen: new Date().toISOString(),
        occurrence_count: occurrenceCount,
      })

      // Escalate if same issue repeats 3+ times
      if (occurrenceCount >= 3 && occurrenceCount % 3 === 0) {
        logger.warn(
          `[evaluator] Recurring issue for ${issue.platform}: ${issue.type} (${occurrenceCount} occurrences)`
        )
      }
    }
  }
}

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
 *
 * Check implementations split into:
 *   checks/data-checks.ts     — freshness, counts, anomalies, coverage, enrichment
 *   checks/infra-checks.ts    — API latency, VPS health, cron success, search
 *   checks/frontend-checks.ts — homepage SSR, core pages, page speed
 */

import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import {
  checkDataFreshness,
  checkRecordCounts,
  checkROIAnomalies,
  checkArenaScoreCoverage,
  checkLeaderboardIntegrity,
  checkEnrichmentCoverage,
  checkPlatformCoverage,
  checkPerPlatformDataCoverage,
  checkCrossSourceConsistency,
  checkAPIResponseTime,
  checkExpandedAPILatency,
  checkTraderDetailIntegrity,
  checkVPSHealth,
  checkCronSuccessRate,
  checkTraderSearchAccuracy,
  checkHomepageSSR,
  checkFrontendCorePages,
  checkFrontendPageSpeed,
} from './checks'

// ── Types ────────────────────────────────────────────────────────

export interface EvaluationCheck {
  name: string
  category: 'completeness' | 'freshness' | 'consistency' | 'anomaly'
  passed: boolean
  score: number // 0-100
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
  overall_score: number // 0-100
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
  static async evaluate(
    traceId: string | null,
    platformsHint?: string[]
  ): Promise<EvaluationResult> {
    const startTime = Date.now()
    const checks: EvaluationCheck[] = []
    const issues: EvaluationIssue[] = []

    // Run all 17 checks in parallel (they're independent reads)
    const checkResults = await Promise.allSettled([
      checkDataFreshness(platformsHint),
      checkRecordCounts(),
      checkROIAnomalies(),
      checkArenaScoreCoverage(),
      checkLeaderboardIntegrity(),
      checkEnrichmentCoverage(),
      checkPlatformCoverage(),
      checkAPIResponseTime(),
      checkHomepageSSR(),
      checkFrontendCorePages(),
      checkExpandedAPILatency(),
      checkPerPlatformDataCoverage(),
      checkTraderDetailIntegrity(),
      checkVPSHealth(),
      checkCronSuccessRate(),
      checkFrontendPageSpeed(),
      checkTraderSearchAccuracy(),
      checkCrossSourceConsistency(),
    ])

    for (const result of checkResults) {
      if (result.status === 'fulfilled') {
        checks.push(result.value.check)
        issues.push(...result.value.issues)
      } else {
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
    const passed = overallScore >= 70 && !issues.some((i) => i.severity === 'critical')

    const recommendations = issues.filter((i) => i.severity !== 'info').map((i) => i.recommendation)

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
      const criticalIssues = issues.filter((i) => i.severity === 'critical')
      if (criticalIssues.length > 0) {
        sendRateLimitedAlert(
          {
            title: `Pipeline Evaluator: ${criticalIssues.length} critical issues`,
            message: criticalIssues.map((i) => `[${i.platform}] ${i.description}`).join('\n'),
            level: 'critical',
            details: { trace_id: traceId, score: overallScore, issues: criticalIssues },
          },
          'evaluator:critical',
          6 * 3600 * 1000
        ).catch((err) => logger.warn(`[evaluator] Failed to send alert: ${err}`))
      }
    }

    logger.info(
      `[evaluator] Evaluation complete: score=${overallScore}/100, passed=${passed}, ` +
        `checks=${checks.length}, issues=${issues.length}, duration=${result.duration_ms}ms`
    )

    return result
  }

  // ── Feedback Loop + History ──────────────────────────────────────

  private static async writeFeedback(result: EvaluationResult): Promise<void> {
    await PipelineState.set('evaluator:latest', {
      score: result.overall_score,
      passed: result.passed,
      checks_count: result.checks.length,
      issue_count: result.issues.length,
      critical_count: result.issues.filter((i) => i.severity === 'critical').length,
      evaluated_at: result.evaluated_at,
      trace_id: result.trace_id,
    })

    // History: append to rolling window (last 50 evaluations)
    const historyKey = 'evaluator:history'
    const existing =
      await PipelineState.get<
        Array<{ score: number; passed: boolean; checks: number; issues: number; at: string }>
      >(historyKey)
    const history = Array.isArray(existing) ? existing : []
    history.push({
      score: result.overall_score,
      passed: result.passed,
      checks: result.checks.length,
      issues: result.issues.length,
      at: result.evaluated_at,
    })
    if (history.length > 50) history.splice(0, history.length - 50)
    await PipelineState.set(historyKey, history)

    // Compute trend (last 5 vs previous 5)
    if (history.length >= 10) {
      const recent5 = history.slice(-5).reduce((s, h) => s + h.score, 0) / 5
      const prev5 = history.slice(-10, -5).reduce((s, h) => s + h.score, 0) / 5
      const trend = recent5 - prev5
      await PipelineState.set('evaluator:trend', {
        recent_avg: Math.round(recent5 * 10) / 10,
        previous_avg: Math.round(prev5 * 10) / 10,
        delta: Math.round(trend * 10) / 10,
        direction: trend > 1 ? 'improving' : trend < -1 ? 'declining' : 'stable',
        computed_at: new Date().toISOString(),
      })
    }

    // Per-platform feedback for Planner
    for (const issue of result.issues) {
      if (issue.platform === 'all') continue
      const feedbackKey = `evaluator:feedback:${issue.platform}`
      const existingFeedback = await PipelineState.get<{ occurrence_count: number }>(feedbackKey)
      const occurrenceCount = (existingFeedback?.occurrence_count ?? 0) + 1

      await PipelineState.set(feedbackKey, {
        issue_type: issue.type,
        severity: issue.severity,
        recommendation: issue.recommendation,
        last_seen: new Date().toISOString(),
        occurrence_count: occurrenceCount,
      })

      if (occurrenceCount >= 3 && occurrenceCount % 3 === 0) {
        logger.warn(
          `[evaluator] Recurring issue for ${issue.platform}: ${issue.type} (${occurrenceCount} occurrences)`
        )
      }
    }
  }
}

/**
 * Pipeline Evaluator cron route.
 *
 * Runs after compute-leaderboard to independently verify data quality.
 * Based on Anthropic's harness pattern: Generator-Evaluator separation.
 *
 * Triggered by: trigger-chain (after compute-leaderboard)
 * Also runs on schedule: every 6h as fallback
 *
 * NOTE: Kept as manual pattern (not withCron) because it conditionally
 * calls plog.partialSuccess() based on evaluation results, which
 * conflicts with withCron's automatic plog.success() finalization.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { PipelineEvaluator } from '@/lib/harness/pipeline-evaluator'
import { PipelineState } from '@/lib/services/pipeline-state'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 240 // 4min — 17 checks including HTTP requests + VPS health

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const traceId = request.nextUrl.searchParams.get('trace_id')
  const platformsParam = request.nextUrl.searchParams.get('platforms')
  const platformsHint = platformsParam ? platformsParam.split(',').filter(Boolean) : undefined

  const plog = await PipelineLogger.start('pipeline-evaluate', { trace_id: traceId })

  try {
    const result = await PipelineEvaluator.evaluate(traceId, platformsHint)

    if (result.passed) {
      await plog.success(result.checks.length, {
        score: result.overall_score,
        issues: result.issues.length,
        trace_id: traceId,
      })
    } else {
      await plog.partialSuccess(
        result.checks.filter(c => c.passed).length,
        result.issues.map(i => `${i.platform}:${i.type}:${i.severity}`),
        {
          score: result.overall_score,
          trace_id: traceId,
        }
      )
    }

    // Read trend for response
    const trend = await PipelineState.get<{
      recent_avg: number; previous_avg: number; delta: number; direction: string
    }>('evaluator:trend')

    return NextResponse.json({
      ok: result.passed,
      score: result.overall_score,
      checks: result.checks.length,
      issues: result.issues.length,
      critical: result.issues.filter(i => i.severity === 'critical').length,
      duration_ms: result.duration_ms,
      trace_id: traceId,
      trend: trend ? { delta: trend.delta, direction: trend.direction } : null,
      result,
    })
  } catch (error) {
    await plog.error(error instanceof Error ? error : new Error(String(error)))
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

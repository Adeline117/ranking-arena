/**
 * POST /api/hooks/post-deploy
 *
 * Called after Vercel deployment completes (via Vercel Deploy Hook or GitHub Action).
 * Triggers pipeline-evaluate and sends Telegram alert if score < 90.
 *
 * Can also be called manually: curl -X POST -H "Authorization: Bearer CRON_SECRET" .../api/hooks/post-deploy
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineEvaluator } from '@/lib/harness/pipeline-evaluator'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 240

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (env.CRON_SECRET && authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const deployId = request.nextUrl.searchParams.get('deploy_id') || 'manual'
  const DEPLOY_THRESHOLD = 90

  try {
    logger.info(`[post-deploy] Running evaluate for deploy=${deployId}`)
    const result = await PipelineEvaluator.evaluate(`deploy:${deployId}`)

    // Store deploy evaluation
    await PipelineState.set('evaluator:deploy:latest', {
      deploy_id: deployId,
      score: result.overall_score,
      passed: result.overall_score >= DEPLOY_THRESHOLD,
      checks: result.checks.length,
      issues: result.issues.length,
      evaluated_at: result.evaluated_at,
    })

    // Alert if below threshold
    if (result.overall_score < DEPLOY_THRESHOLD) {
      const failedChecks = result.checks
        .filter(c => c.score < 80)
        .map(c => `${c.name}: ${c.score}/100 — ${c.details}`)

      await sendRateLimitedAlert(
        {
          title: `POST-DEPLOY: Score ${result.overall_score}/100 (threshold: ${DEPLOY_THRESHOLD})`,
          message: [
            `Deploy: ${deployId}`,
            `Score: ${result.overall_score}/100`,
            '',
            ...failedChecks,
            '',
            result.issues.length > 0
              ? `${result.issues.length} issues, ${result.issues.filter(i => i.severity === 'critical').length} critical`
              : 'No critical issues',
          ].join('\n'),
          level: result.overall_score < 70 ? 'critical' : 'warning',
          details: {
            deploy_id: deployId,
            score: result.overall_score,
            threshold: DEPLOY_THRESHOLD,
            failed_checks: failedChecks.length,
          },
        },
        'post-deploy:alert',
        10 * 60 * 1000 // 10min rate limit
      )

      logger.warn(`[post-deploy] Score ${result.overall_score} below threshold ${DEPLOY_THRESHOLD} for deploy=${deployId}`)
    }

    return NextResponse.json({
      ok: result.overall_score >= DEPLOY_THRESHOLD,
      score: result.overall_score,
      threshold: DEPLOY_THRESHOLD,
      checks: result.checks.length,
      issues: result.issues.length,
      deploy_id: deployId,
      duration_ms: result.duration_ms,
    })
  } catch (error) {
    logger.error(`[post-deploy] Evaluate failed for deploy=${deployId}`, {}, error instanceof Error ? error : new Error(String(error)))
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

// Also support GET for easier testing
export async function GET(request: NextRequest) {
  return POST(request)
}

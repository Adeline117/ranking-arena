/**
 * GET /api/health/evaluate-report
 *
 * Receives code quality evaluation scores from pre-push hook.
 * Writes to pipeline_state and sends Telegram alert if score < 80.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (env.CRON_SECRET && authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const score = parseInt(request.nextUrl.searchParams.get('score') || '0', 10)
  const source = request.nextUrl.searchParams.get('source') || 'unknown'

  // Write to pipeline_state
  await PipelineState.set('evaluator:code-quality:latest', {
    score,
    source,
    passed: score >= 80,
    evaluated_at: new Date().toISOString(),
  })

  // Alert if below threshold
  if (score < 80) {
    await sendRateLimitedAlert(
      {
        title: `Code Quality Below Threshold: ${score}/100`,
        message: `Source: ${source}\nScore: ${score}/100 (threshold: 80)\nAction: Fix issues before pushing.`,
        level: score < 50 ? 'critical' : 'warning',
        details: { score, source, threshold: 80 },
      },
      'code-quality:alert',
      30 * 60 * 1000 // 30min rate limit
    )
  }

  return NextResponse.json({ ok: true, score, source, written: true })
}

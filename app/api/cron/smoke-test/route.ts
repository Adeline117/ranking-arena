/**
 * Smoke Test Cron — runs every 30 minutes
 *
 * Fetches 5 critical pages on the live site and checks for 500 errors.
 * If any fail, sends a Telegram alert so someone can roll back.
 *
 * Root cause prevention: 2026-04-22 incident where 629 commits shipped
 * without verification, causing 3 BLOCKERs + 8 HIGHs to accumulate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const CRITICAL_PATHS = ['/', '/trader/soul', '/login', '/pricing', '/api/health']

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('smoke-test')

  const base =
    process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://www.arenafi.org'
  const results: Array<{ path: string; status: number; ok: boolean; ms: number }> = []

  for (const path of CRITICAL_PATHS) {
    const start = Date.now()
    try {
      const res = await fetch(`${base}${path}?_smoke=${Date.now()}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'ArenaSmoke/1.0' },
      })
      results.push({
        path,
        status: res.status,
        ok: res.status !== 500,
        ms: Date.now() - start,
      })
    } catch {
      results.push({ path, status: 0, ok: false, ms: Date.now() - start })
    }
  }

  const failures = results.filter((r) => !r.ok)

  if (failures.length > 0) {
    const failList = failures.map((f) => `${f.path} → ${f.status}`).join('\n')
    await sendRateLimitedAlert(
      {
        title: `🚨 SMOKE TEST: ${failures.length}/${results.length} critical paths failing`,
        message: `Failures:\n${failList}\n\nAction: Roll back in Vercel Dashboard`,
        level: 'critical',
      },
      'smoke-test-failure',
      1800000 // 30 min rate limit
    )
    await plog.partialSuccess(
      results.length - failures.length,
      failures.map((f) => `${f.path}:${f.status}`),
      { results }
    )
  } else {
    await plog.success(results.length, { results })
  }

  return NextResponse.json({
    ok: failures.length === 0,
    checked: results.length,
    failed: failures.length,
    results,
  })
}

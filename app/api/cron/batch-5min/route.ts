/**
 * Batch dispatcher for all "every 5 minutes" cron jobs.
 * 
 * Consolidates:
 * - /api/cron/run-worker (GET)
 * - /api/cron/refresh-hot-scores (GET)
 * - /api/trader/sync (POST - triggers sync for all pending authorizations)
 *
 * Schedule: every 5 min (see vercel.json)
 * Saves 2 cron slots by combining 3 jobs into 1.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes — longest of the three

interface BatchResult {
  name: string
  status: 'success' | 'error'
  durationMs: number
  error?: string
}

async function callInternal(baseUrl: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<BatchResult> {
  const name = path
  const start = Date.now()

  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${process.env.CRON_SECRET}`,
    }
    // Bypass Vercel Deployment Protection for internal cron calls
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    }

    const opts: RequestInit = { method, headers }
    if (body) {
      headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }

    const res = await fetch(`${baseUrl}${path}`, opts)
    const durationMs = Date.now() - start

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown')
      return { name, status: 'error', durationMs, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }

    return { name, status: 'success', durationMs }
  } catch (err) {
    return {
      name,
      status: 'error',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Prefer production domain (no deployment protection) over VERCEL_URL
  // Each sub-job has maxDuration ≤ 60s, well within Cloudflare's proxy timeout
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  const startTime = Date.now()

  // Run core jobs in parallel — they are independent
  const results = await Promise.all([
    callInternal(baseUrl, '/api/cron/run-worker'),
    callInternal(baseUrl, '/api/cron/refresh-hot-scores'),
    callInternal(baseUrl, '/api/trader/sync', 'POST', {}),
  ])

  const totalDuration = Date.now() - startTime
  const hasErrors = results.some(r => r.status === 'error')
  const plog = await PipelineLogger.start('batch-5min')
  const succeeded = results.filter(r => r.status === 'success').length
  if (hasErrors) {
    await plog.error(new Error(`${results.length - succeeded}/${results.length} sub-jobs failed`), { results })
  } else {
    await plog.success(succeeded, { results })
  }

  return NextResponse.json({
    batch: 'batch-5min',
    status: hasErrors ? 'partial' : 'success',
    totalDurationMs: totalDuration,
    results,
  }, {
    status: hasErrors ? 207 : 200, // 207 Multi-Status for partial success
  })
}

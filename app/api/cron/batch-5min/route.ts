/**
 * Batch dispatcher for all "every 5 minutes" cron jobs.
 * 
 * Consolidates:
 * - /api/cron/run-worker (GET)
 * - /api/cron/refresh-hot-scores (GET)
 * - /api/trader/sync (POST - triggers sync for all pending authorizations)
 *
 * Schedule: */5 * * * * (see vercel.json)
 * Saves 2 cron slots by combining 3 jobs into 1.
 */

import { NextRequest, NextResponse } from 'next/server'

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
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`
    || 'http://localhost:3000'

  const startTime = Date.now()

  // Run all three in parallel — they are independent
  const results = await Promise.all([
    callInternal(baseUrl, '/api/cron/run-worker'),
    callInternal(baseUrl, '/api/cron/refresh-hot-scores'),
    callInternal(baseUrl, '/api/trader/sync', 'POST', {}),
  ])

  const totalDuration = Date.now() - startTime
  const hasErrors = results.some(r => r.status === 'error')

  return NextResponse.json({
    batch: 'batch-5min',
    status: hasErrors ? 'partial' : 'success',
    totalDurationMs: totalDuration,
    results,
  }, {
    status: hasErrors ? 207 : 200, // 207 Multi-Status for partial success
  })
}

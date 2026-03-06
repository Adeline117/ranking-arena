/**
 * Batch discover dispatcher
 * 
 * Consolidates discover-traders and discover-rankings into one cron job.
 * Previously these ran at :56 and :58 every 4h — now one cron at :56 every 4h.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ENDPOINTS = [
  '/api/cron/discover-traders',
  '/api/cron/discover-rankings',
]

interface BatchResult {
  name: string
  status: 'success' | 'error'
  durationMs: number
  error?: string
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  const results: BatchResult[] = []

  for (const endpoint of ENDPOINTS) {
    const start = Date.now()
    try {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${cronSecret}` },
      })
      results.push({
        name: endpoint,
        status: res.ok ? 'success' : 'error',
        durationMs: Date.now() - start,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      })
    } catch (err) {
      results.push({
        name: endpoint,
        status: 'error',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const plog = await PipelineLogger.start('batch-discover')
  const succeeded = results.filter((r) => r.status === 'success').length
  if (succeeded === results.length) {
    await plog.success(succeeded)
  } else {
    await plog.error(new Error(`${results.length - succeeded}/${results.length} failed`), { results })
  }

  return NextResponse.json({
    ok: results.every((r) => r.status === 'success'),
    results,
  })
}

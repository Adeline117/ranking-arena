/**
 * Retired dead-letter "retry" loop (2026-11 audit P2-2).
 *
 * The former job read `enrich:dead:*` and `reconciliation:gaps:*` from
 * PipelineState and rewrote them as `enrich:retry:*` keys. Nothing in the
 * repository produces `enrich:dead:*` anymore (the enrichment runner was
 * removed) and nothing consumes `enrich:retry:*`, so every run DISCARDED the
 * reconciliation gaps while reporting `retried: N` as a success.
 *
 * Gap detection itself stays in data-reconciliation (alert only). A future
 * retry path must enqueue real work on the ingest worker queues and prove a
 * consumer exists; it must not be revived as a key-rewriting no-op.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'

function retiredResponse(request: NextRequest): NextResponse {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json(
    {
      error: 'Retired cron route',
      reason: 'no producer for enrich:dead:* and no consumer for enrich:retry:*',
      replacement: 'data-reconciliation (alert only); ingest worker schedules own re-crawls',
    },
    { status: 410 }
  )
}

export const GET = retiredResponse
export const POST = retiredResponse

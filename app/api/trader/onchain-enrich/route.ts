/**
 * Retired V1 on-demand on-chain enrichment endpoint.
 *
 * This fixed source response returns before reading a request body, checking a
 * rate limit, contacting a provider, or reading/writing serving data. It does
 * not establish the state of an existing worker or external scheduler.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { V1_INGEST_EXECUTION_NOT_PUBLISHED_CODE } from '@/lib/ingest/v1-execution-publication'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

export function POST(_request: NextRequest) {
  return NextResponse.json(
    { error: V1_INGEST_EXECUTION_NOT_PUBLISHED_CODE },
    { headers: NO_STORE_HEADERS, status: 410 }
  )
}

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  TOKEN_RANKING_CONTAINMENT_BODY,
  TOKEN_RANKING_CONTAINMENT_HEADERS,
} from '@/lib/rankings/token-ranking-containment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Emergency publication hold. Keep this response ahead of request parsing,
 * rate limiting, caches, and database access until token-ranking authority is
 * independently verified and this containment is deliberately reverted.
 */
export function GET(_request?: NextRequest): NextResponse {
  return NextResponse.json(TOKEN_RANKING_CONTAINMENT_BODY, {
    status: 503,
    headers: TOKEN_RANKING_CONTAINMENT_HEADERS,
  })
}

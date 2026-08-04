import { NextResponse } from 'next/server'

const RETIRED_OAUTH_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Link: '</api/trader/authorize>; rel="successor-version"',
} as const

/**
 * OAuth credential storage is retired for V1. It may return only after token
 * encryption, read-only scope proof, and bind/revoke concurrency share the
 * same service-only lifecycle transaction as API-key connections.
 */
export function retiredExchangeOAuthResponse() {
  return NextResponse.json(
    {
      success: false,
      error: 'Exchange OAuth is unavailable in Arena V1. Use read-only API key binding.',
      successor: '/api/trader/authorize',
    },
    { status: 410, headers: RETIRED_OAUTH_HEADERS }
  )
}

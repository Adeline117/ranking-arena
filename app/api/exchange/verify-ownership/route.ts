/**
 * /api/exchange/verify-ownership — RETIRED
 *
 * A CEX account UID is not guaranteed to equal the opaque identity used by a
 * public copy-trading leaderboard. Treating that comparison as profile claim
 * proof was unsafe, so immutable callers now fail closed. Read-only CEX
 * account connections remain available through /api/trader/authorize.
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

export const POST = withAuth(
  async () =>
    NextResponse.json(
      {
        success: false,
        verified: false,
        error: 'CEX leaderboard ownership verification is retired.',
        code: 'CEX_LEADERBOARD_OWNERSHIP_VERIFICATION_RETIRED',
        message:
          'A read-only CEX connection is private and cannot prove ownership of or publish a public leaderboard profile. V1 claims support Hyperliquid and GMX wallet signatures only.',
        replacements: {
          account_connection: '/api/trader/authorize',
          profile_claim: '/api/traders/claim',
        },
      },
      {
        status: 410,
        headers: {
          ...NO_STORE_HEADERS,
          Deprecation: 'true',
          Link: '</api/trader/authorize>; rel="alternate", </api/traders/claim>; rel="successor-version"',
        },
      }
    ),
  {
    name: 'verify-ownership-retired',
    rateLimit: 'sensitive',
  }
)

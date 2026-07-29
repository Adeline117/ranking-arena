import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { cookies } from 'next/headers'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { storeSiweNonce } from '@/lib/auth/siwe-nonce'
import logger from '@/lib/logger'

/**
 * GET /api/auth/siwe/nonce
 *
 * Generates a random nonce for SIWE (Sign-In with Ethereum).
 * Stores the nonce in an httpOnly cookie for server-side verification.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.auth)
    if (rateLimitResponse) return rateLimitResponse
    const nonce = randomBytes(32).toString('hex')

    // Persist before returning it. A cookie without this server-side single-use
    // record is never accepted by either verifier.
    await storeSiweNonce(nonce)

    const cookieStore = await cookies()
    cookieStore.set('siwe-nonce', nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 300, // 5 minutes
      path: '/',
    })

    return NextResponse.json({ nonce })
  } catch (error) {
    logger.error('[siwe/nonce] Error:', error)
    return NextResponse.json({ error: 'Failed to generate nonce' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { cookies } from 'next/headers'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

/**
 * GET /api/auth/siwe/nonce
 *
 * Generates a random nonce for SIWE (Sign-In with Ethereum).
 * Stores the nonce in an httpOnly cookie for server-side verification.
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.auth)
  if (rateLimitResponse) return rateLimitResponse
  const nonce = randomBytes(32).toString('hex')

  const cookieStore = await cookies()
  cookieStore.set('siwe-nonce', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 300, // 5 minutes
    path: '/',
  })

  return NextResponse.json({ nonce })
}

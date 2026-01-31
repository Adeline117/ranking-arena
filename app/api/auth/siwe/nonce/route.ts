import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { cookies } from 'next/headers'

/**
 * GET /api/auth/siwe/nonce
 *
 * Generates a random nonce for SIWE (Sign-In with Ethereum).
 * Stores the nonce in an httpOnly cookie for server-side verification.
 */
export async function GET() {
  const nonce = randomBytes(16).toString('hex')

  const cookieStore = await cookies()
  cookieStore.set('siwe-nonce', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 300, // 5 minutes
    path: '/',
  })

  return NextResponse.json({ nonce })
}

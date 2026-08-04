/**
 * POST /api/traders/claim/wallet-challenge
 *
 * Issues the only wallet message accepted by the trader-claim endpoint. The
 * message is bound to the authenticated user, canonical source and trader,
 * Arena domain, a cryptographically random nonce, and a short expiry.
 */

import { NextRequest } from 'next/server'
import {
  checkRateLimit,
  getSupabaseAdmin,
  handleError,
  RateLimitPresets,
  requireAuth,
  success,
  validateString,
} from '@/lib/api'
import { ApiError } from '@/lib/api/errors'
import { isTraderClaimed } from '@/lib/data/trader-claims'
import { claimMethodForSource } from '@/lib/constants/trader-claim-platforms'
import { canonicalizeWalletIdentity } from '@/lib/validators/wallet-identity'
import { createWalletClaimChallenge } from '@/lib/services/wallet-verification'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const body = await request.json()
    const rawTraderId = validateString(body.trader_id, {
      required: true,
      maxLength: 512,
      fieldName: 'trader_id',
    })
    const rawSource = validateString(body.source, {
      required: true,
      maxLength: 100,
      fieldName: 'source',
    })
    if (!rawTraderId || !rawSource) throw ApiError.validation('Missing required parameters')

    const source = rawSource.toLowerCase()
    if (claimMethodForSource(source) !== 'signature') {
      throw ApiError.validation(`Source ${source} does not support wallet claim challenges`)
    }

    const traderId = canonicalizeWalletIdentity(rawTraderId, source)
    if (await isTraderClaimed(getSupabaseAdmin(), traderId, source)) {
      throw ApiError.validation('This trader account has been claimed or is under review')
    }

    const challenge = await createWalletClaimChallenge(user.id, source, traderId)
    return success(challenge, 200, { 'Cache-Control': 'private, no-store' })
  } catch (error: unknown) {
    const response = handleError(error, 'wallet claim challenge POST')
    if ((error as { statusCode?: unknown })?.statusCode === 503) {
      response.headers.set('Retry-After', '30')
      response.headers.set('Cache-Control', 'private, no-store')
    }
    return response
  }
}

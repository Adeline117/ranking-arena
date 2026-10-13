/**
 * Verified Trader Profile API
 * GET /api/traders/verified?trader_id=xxx&source=yyy - Check if trader is verified
 * PUT /api/traders/verified - Update verified trader profile
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
  validateString,
} from '@/lib/api'
import { ApiError } from '@/lib/api/errors'
import {
  getVerifiedTrader,
  updateVerifiedTrader,
  type UpdateVerifiedTraderInput,
} from '@/lib/data/trader-claims'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { canonicalizeWalletIdentity } from '@/lib/validators/wallet-identity'
import { parseOptionalDiscordHandle, parseOptionalProfileUrl } from '@/lib/utils/profile-url'

/**
 * GET /api/traders/verified?trader_id=xxx&source=yyy
 * Public: check if a trader is verified
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    const traderId = searchParams.get('trader_id')
    const source = searchParams.get('source')

    if (!traderId || !source) {
      return success({ is_verified: false, verified_trader: null })
    }

    const verified = await getVerifiedTrader(supabase, traderId, source)

    return success({
      is_verified: !!verified,
      verified_trader: verified
        ? {
            display_name: verified.display_name,
            bio: verified.bio,
            avatar_url: verified.avatar_url,
            twitter_url: verified.twitter_url,
            telegram_url: verified.telegram_url,
            discord_url: verified.discord_url,
            website_url: verified.website_url,
            verified_at: verified.verified_at,
            verification_method: verified.verification_method,
          }
        : null,
    })
  } catch (error: unknown) {
    return handleError(error, 'verified trader GET')
  }
}

/**
 * PUT /api/traders/verified
 * Authenticated: update own verified trader profile
 */
export async function PUT(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
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
    if (!rawTraderId || !rawSource) {
      throw ApiError.validation('trader_id and source are required')
    }
    const source = rawSource.toLowerCase()
    let traderId = rawTraderId
    if (isDexWalletPlatform(source)) {
      try {
        traderId = canonicalizeWalletIdentity(rawTraderId, source)
      } catch (error) {
        throw ApiError.validation(
          error instanceof Error ? error.message : 'Invalid trader identity'
        )
      }
    }

    const input: UpdateVerifiedTraderInput = {}

    if (body.display_name !== undefined)
      input.display_name = String(body.display_name).slice(0, 100)
    if (body.bio !== undefined) input.bio = String(body.bio).slice(0, 500)
    // Links are rendered as href/src — only safe https URLs (shared with
    // /api/traders/claim/profile). Rejects javascript:, data:, http, etc.
    for (const field of ['avatar_url', 'twitter_url', 'telegram_url', 'website_url'] as const) {
      if (body[field] === undefined) continue
      const parsed = parseOptionalProfileUrl(body[field])
      if (!parsed.ok) throw ApiError.validation(`Invalid URL for ${field}`)
      input[field] = parsed.value
    }
    if (body.discord_url !== undefined) {
      const parsed = parseOptionalDiscordHandle(body.discord_url)
      if (!parsed.ok) throw ApiError.validation('Invalid discord_url')
      input.discord_url = parsed.value
    }
    if (body.can_receive_messages !== undefined)
      input.can_receive_messages = !!body.can_receive_messages

    const updated = await updateVerifiedTrader(
      supabase,
      user.id,
      { trader_id: traderId, source },
      input
    )
    if (
      !updated ||
      updated.user_id !== user.id ||
      updated.trader_id !== traderId ||
      updated.source !== source
    ) {
      throw ApiError.forbidden('You do not own this verified trader profile')
    }

    return success({ verified_trader: updated })
  } catch (error: unknown) {
    return handleError(error, 'verified trader PUT')
  }
}

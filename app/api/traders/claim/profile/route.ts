/**
 * Verified Trader Profile Edit API
 * PUT /api/traders/claim/profile
 *
 * Allows verified traders to update their display_name, bio, and social links.
 * Only the user who verified the trader profile can make edits.
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
import { updateVerifiedTrader } from '@/lib/data/trader-claims'
import { createLogger } from '@/lib/utils/logger'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { canonicalizeWalletIdentity } from '@/lib/validators/wallet-identity'
import { parseOptionalDiscordHandle, parseOptionalProfileUrl } from '@/lib/utils/profile-url'

const logger = createLogger('claim-profile')

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

    // Sanitize inputs
    const updates: Record<string, string | null | boolean | undefined> = {}

    if (body.display_name !== undefined) {
      const name = typeof body.display_name === 'string' ? body.display_name.trim() : null
      if (name && name.length > 50) {
        throw ApiError.validation('Display name must be 50 characters or less')
      }
      updates.display_name = name || null
    }

    if (body.bio !== undefined) {
      const bio = typeof body.bio === 'string' ? body.bio.trim() : null
      if (bio && bio.length > 280) {
        throw ApiError.validation('Bio must be 280 characters or less')
      }
      updates.bio = bio || null
    }

    for (const field of ['twitter_url', 'telegram_url', 'website_url'] as const) {
      if (body[field] !== undefined) {
        const parsed = parseOptionalProfileUrl(body[field])
        if (!parsed.ok) throw ApiError.validation(`Invalid URL for ${field}`)
        updates[field] = parsed.value
      }
    }

    if (body.discord_url !== undefined) {
      const parsed = parseOptionalDiscordHandle(body.discord_url)
      if (!parsed.ok) throw ApiError.validation('Invalid discord_url')
      updates.discord_url = parsed.value
    }

    if (body.avatar_url !== undefined) {
      const parsed = parseOptionalProfileUrl(body.avatar_url)
      if (!parsed.ok) throw ApiError.validation('Invalid avatar URL')
      updates.avatar_url = parsed.value
    }

    if (body.can_receive_messages !== undefined) {
      updates.can_receive_messages = !!body.can_receive_messages
    }

    if (Object.keys(updates).length === 0) {
      throw ApiError.validation('No fields to update')
    }

    const updated = await updateVerifiedTrader(
      supabase,
      user.id,
      { trader_id: traderId, source },
      updates
    )
    if (
      !updated ||
      updated.user_id !== user.id ||
      updated.trader_id !== traderId ||
      updated.source !== source
    ) {
      throw ApiError.forbidden('You do not own this verified trader profile.')
    }

    logger.info('Verified trader profile updated', {
      userId: user.id,
      traderId,
      source,
      fields: Object.keys(updates),
    })

    return success({
      verified_trader: updated,
      message: 'Profile updated successfully',
    })
  } catch (error: unknown) {
    logger.error('Claim profile update failed', { error })
    return handleError(error, 'claim profile PUT')
  }
}

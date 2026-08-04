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
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { isVerifiedTraderProfileConflict, updateVerifiedTrader } from '@/lib/data/trader-claims'
import { createLogger } from '@/lib/utils/logger'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { canonicalizeWalletIdentity } from '@/lib/validators/wallet-identity'

const logger = createLogger('claim-profile')
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

function withPrivateNoStore<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

export async function PUT(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return withPrivateNoStore(rateLimitResponse)

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
    if (
      typeof body.profile_version !== 'number' ||
      !Number.isSafeInteger(body.profile_version) ||
      body.profile_version < 0
    ) {
      throw ApiError.validation('A valid profile_version is required')
    }
    const profileVersion = body.profile_version

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

    // URL validation helper — only allow https URLs, block internal hosts
    function isValidUrl(url: string): boolean {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:') return false
        const host = parsed.hostname.toLowerCase()
        if (
          host === 'localhost' ||
          host === '127.0.0.1' ||
          host === '0.0.0.0' ||
          host.endsWith('.local')
        )
          return false
        return true
      } catch {
        return false
      }
    }

    for (const field of ['twitter_url', 'telegram_url', 'website_url'] as const) {
      if (body[field] !== undefined) {
        const value = typeof body[field] === 'string' ? body[field].trim() : null
        if (value && !isValidUrl(value)) {
          throw ApiError.validation(`Invalid URL for ${field}`)
        }
        updates[field] = value || null
      }
    }

    if (body.discord_url !== undefined) {
      const value = typeof body.discord_url === 'string' ? body.discord_url.trim() : null
      updates.discord_url = value || null
    }

    if (body.avatar_url !== undefined) {
      const value = typeof body.avatar_url === 'string' ? body.avatar_url.trim() : null
      if (value && !isValidUrl(value)) {
        throw ApiError.validation('Invalid avatar URL')
      }
      updates.avatar_url = value || null
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
      profileVersion,
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

    return withPrivateNoStore(
      success({
        verified_trader: updated,
        message: 'Profile updated successfully',
      })
    )
  } catch (error: unknown) {
    logger.error('Claim profile update failed', { error })
    if (isVerifiedTraderProfileConflict(error)) {
      return withPrivateNoStore(
        handleError(
          new ApiError('Profile changed since it was loaded; your draft was not saved', {
            code: ErrorCode.DUPLICATE_ACTION,
          }),
          'claim profile PUT'
        )
      )
    }
    return withPrivateNoStore(handleError(error, 'claim profile PUT'))
  }
}

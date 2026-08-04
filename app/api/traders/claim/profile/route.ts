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
} from '@/lib/api'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { isVerifiedTraderProfileConflict, updateVerifiedTrader } from '@/lib/data/trader-claims'
import { createLogger } from '@/lib/utils/logger'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { canonicalizeWalletIdentity } from '@/lib/validators/wallet-identity'

const logger = createLogger('claim-profile')

const PROFILE_UPDATE_FIELDS = [
  'display_name',
  'bio',
  'avatar_url',
  'twitter_url',
  'telegram_url',
  'discord_url',
  'website_url',
  'can_receive_messages',
] as const

const PROFILE_REQUEST_FIELDS = new Set([
  'trader_id',
  'source',
  'profile_version',
  ...PROFILE_UPDATE_FIELDS,
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedRequiredString(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== 'string') throw ApiError.validation(`${fieldName} must be a string`)
  const normalized = value.trim()
  if (!normalized) throw ApiError.validation(`${fieldName} is required`)
  if (normalized.length > maxLength) {
    throw ApiError.validation(`${fieldName} must be ${maxLength} characters or less`)
  }
  return normalized
}

function normalizedNullableString(
  value: unknown,
  fieldName: string,
  maxLength: number
): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw ApiError.validation(`${fieldName} must be a string or null`)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw ApiError.validation(`${fieldName} must be ${maxLength} characters or less`)
  }
  return normalized || null
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return !(
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '[::1]' ||
      host.endsWith('.local')
    )
  } catch {
    return false
  }
}

function normalizedNullableUrl(value: unknown, fieldName: string): string | null {
  const normalized = normalizedNullableString(value, fieldName, 4096)
  if (normalized && !isValidUrl(normalized)) {
    throw ApiError.validation(`Invalid URL for ${fieldName}`)
  }
  return normalized
}

async function readProfileUpdateBody(request: NextRequest): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw ApiError.validation('Request body must be valid JSON')
  }
  if (!isRecord(value)) throw ApiError.validation('Request body must be an object')
  const unknownFields = Object.keys(value).filter((field) => !PROFILE_REQUEST_FIELDS.has(field))
  if (unknownFields.length > 0) {
    throw ApiError.validation('Unknown profile update fields', { fields: unknownFields })
  }
  return value
}

export async function PUT(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await readProfileUpdateBody(request)
    const rawTraderId = normalizedRequiredString(body.trader_id, 'trader_id', 512)
    const rawSource = normalizedRequiredString(body.source, 'source', 100)
    if (
      typeof body.profile_version !== 'number' ||
      !Number.isSafeInteger(body.profile_version) ||
      body.profile_version < 0 ||
      body.profile_version > 2_147_483_647
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

    const updates: Record<string, string | null | boolean | undefined> = {}

    if (body.display_name !== undefined) {
      updates.display_name = normalizedNullableString(body.display_name, 'display_name', 50)
    }

    if (body.bio !== undefined) {
      updates.bio = normalizedNullableString(body.bio, 'bio', 280)
    }

    for (const field of [
      'avatar_url',
      'twitter_url',
      'telegram_url',
      'discord_url',
      'website_url',
    ] as const) {
      if (body[field] !== undefined) {
        updates[field] = normalizedNullableUrl(body[field], field)
      }
    }

    if (body.can_receive_messages !== undefined) {
      if (typeof body.can_receive_messages !== 'boolean') {
        throw ApiError.validation('can_receive_messages must be a boolean')
      }
      updates.can_receive_messages = body.can_receive_messages
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
    if (updated.profile_version !== profileVersion + 1) {
      throw new Error('Verified trader profile update returned an invalid revision acknowledgement')
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
    if (isVerifiedTraderProfileConflict(error)) {
      return handleError(
        new ApiError('Profile changed since it was loaded; your draft was not saved', {
          code: ErrorCode.DUPLICATE_ACTION,
        }),
        'claim profile PUT'
      )
    }
    return handleError(error, 'claim profile PUT')
  }
}

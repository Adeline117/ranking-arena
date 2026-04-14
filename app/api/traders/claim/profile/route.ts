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
import { ApiError } from '@/lib/api/errors'
import { getUserVerifiedTrader, updateVerifiedTrader } from '@/lib/data/trader-claims'

export async function PUT(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // Verify the user has a verified trader profile
    const verified = await getUserVerifiedTrader(supabase, user.id)
    if (!verified) {
      throw ApiError.forbidden('You do not have a verified trader profile. Claim a profile first.')
    }

    const body = await request.json()

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
        if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) return false
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

    const updated = await updateVerifiedTrader(supabase, user.id, updates)

    return success({
      verified_trader: updated,
      message: 'Profile updated successfully',
    })
  } catch (error: unknown) {
    return handleError(error, 'claim profile PUT')
  }
}

/**
 * POST /api/trader/bind-api-key
 *
 * Bind a read-only CEX API key to a trader profile.
 * Validates the key, encrypts credentials, and stores in trader_authorizations.
 *
 * Body: {
 *   platform: string,      // 'binance', 'bybit', 'okx', 'bitget', etc.
 *   apiKey: string,         // Read-only API key
 *   apiSecret: string,      // API secret
 *   passphrase?: string,    // Required for OKX, Bitget
 *   label?: string,         // User-friendly name
 *   syncFrequency?: string, // 'realtime' | '5min' | '15min' | '1hour'
 * }
 *
 * Returns: {
 *   success: boolean,
 *   authorizationId?: string,
 *   traderId?: string,       // Exchange account UID
 *   nickname?: string,
 *   error?: string,
 * }
 */

import { NextRequest } from 'next/server'
import {
  requireAuth,
  getSupabaseAdmin,
  success,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { bindApiKey } from '@/lib/services/api-key-binder'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    // Validate required fields
    const platform = validateString(body.platform, { required: true, fieldName: 'platform' })
    const apiKey = validateString(body.apiKey, { required: true, fieldName: 'apiKey' })
    const apiSecret = validateString(body.apiSecret, { required: true, fieldName: 'apiSecret' })

    if (!platform || !apiKey || !apiSecret) {
      return handleError(
        new Error('Missing required fields: platform, apiKey, apiSecret'),
        'bind-api-key'
      )
    }

    // Bind the API key
    const result = await bindApiKey(supabase, user.id, {
      platform,
      apiKey,
      apiSecret,
      passphrase: body.passphrase || undefined,
      label: body.label || undefined,
      syncFrequency: body.syncFrequency || undefined,
    })

    if (!result.success) {
      return handleError(new Error(result.error || 'Binding failed'), 'bind-api-key')
    }

    logger.info('[bind-api-key] API key bound', {
      userId: user.id,
      platform,
      traderId: result.traderId,
    })

    return success({
      success: true,
      authorizationId: result.authorizationId,
      traderId: result.traderId,
      nickname: result.nickname,
      message: 'API key bound successfully. Your verified data will be available shortly.',
    })
  } catch (error: unknown) {
    return handleError(error, 'bind-api-key')
  }
}

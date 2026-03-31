/**
 * POST /api/trader/authorize
 *
 * Authorize trader to display real trading data
 * Validates API key and stores encrypted credentials
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { encrypt } from '@/lib/crypto/encryption'
import { validateExchangeApiKey } from '@/lib/validators/api-key-validator'
import { logger } from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

interface AuthorizeRequest {
  platform: string
  apiKey: string
  apiSecret: string
  passphrase?: string
  label?: string
  syncFrequency?: 'realtime' | '5min' | '15min' | '1hour'
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // Get user from auth
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.replace('Bearer ', '')

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    })

    // Get current user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Parse request body
    const body: AuthorizeRequest = await request.json()
    const { platform, apiKey, apiSecret, passphrase, label, syncFrequency } = body

    // Validate required fields
    if (!platform || !apiKey || !apiSecret) {
      return NextResponse.json(
        { error: 'Missing required fields: platform, apiKey, apiSecret' },
        { status: 400 }
      )
    }

    // Validate platform
    const validPlatforms = [
      'binance',
      'binance_futures',
      'binance_spot',
      'bybit',
      'bybit_spot',
      'okx',
      'okx_futures',
      'bitget',
      'bitget_futures',
      'bitget_spot',
    ]

    if (!validPlatforms.includes(platform.toLowerCase())) {
      return NextResponse.json(
        { error: `Unsupported platform: ${platform}` },
        { status: 400 }
      )
    }


    // Validate API key with exchange
    const validationResult = await validateExchangeApiKey(platform, {
      apiKey,
      apiSecret,
      passphrase,
    })

    if (!validationResult.isValid) {
      logger.warn('[Authorize] API key validation failed', {
        platform,
        userId: user.id,
        error: validationResult.error,
      })

      return NextResponse.json(
        {
          error: 'API key validation failed',
          details: validationResult.error,
        },
        { status: 400 }
      )
    }


    // Encrypt credentials
    const encryptedApiKey = encrypt(apiKey)
    const encryptedApiSecret = encrypt(apiSecret)
    const encryptedPassphrase = passphrase ? encrypt(passphrase) : null

    // Use service role client for database write
    const supabaseService = getSupabaseAdmin()

    // Check if authorization already exists
    const { data: existing } = await supabaseService
      .from('trader_authorizations')
      .select('id')
      .eq('user_id', user.id)
      .eq('platform', platform)
      .eq('trader_id', validationResult.traderId!)
      .single()

    let authorizationId: string

    if (existing) {
      // Update existing authorization
      const { data: updated, error: updateError } = await supabaseService
        .from('trader_authorizations')
        .update({
          encrypted_api_key: encryptedApiKey,
          encrypted_api_secret: encryptedApiSecret,
          encrypted_passphrase: encryptedPassphrase,
          permissions: validationResult.permissions || [],
          status: 'active',
          last_verified_at: new Date().toISOString(),
          verification_error: null,
          label,
          sync_frequency: syncFrequency || 'realtime',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('id')
        .single()

      if (updateError) {
        logger.dbError('update-authorization', updateError, {
          userId: user.id,
          platform,
        })
        return NextResponse.json(
          { error: 'Failed to update authorization' },
          { status: 500 }
        )
      }

      authorizationId = updated!.id
    } else {
      // Create new authorization
      const { data: created, error: createError } = await supabaseService
        .from('trader_authorizations')
        .insert({
          user_id: user.id,
          platform,
          trader_id: validationResult.traderId!,
          encrypted_api_key: encryptedApiKey,
          encrypted_api_secret: encryptedApiSecret,
          encrypted_passphrase: encryptedPassphrase,
          permissions: validationResult.permissions || [],
          status: 'active',
          last_verified_at: new Date().toISOString(),
          label,
          sync_frequency: syncFrequency || 'realtime',
        })
        .select('id')
        .single()

      if (createError) {
        logger.dbError('create-authorization', createError, {
          userId: user.id,
          platform,
        })
        return NextResponse.json(
          { error: 'Failed to create authorization' },
          { status: 500 }
        )
      }

      authorizationId = created!.id
    }

    // Trigger initial data sync (async, don't wait)
    fetch(`${env.NEXT_PUBLIC_APP_URL}/api/trader/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CRON_SECRET}`,
      },
      body: JSON.stringify({
        authorizationId,
      }),
    }).catch((error) => {
      logger.error('[Authorize] Failed to trigger initial sync', {}, error)
    })

    return NextResponse.json({
      success: true,
      authorizationId,
      traderId: validationResult.traderId,
      nickname: validationResult.nickname,
      permissions: validationResult.permissions,
      message: 'Authorization successful! Your live trading data will start syncing in a few minutes.',
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/trader/authorize
 *
 * List user's authorizations
 */
export async function GET(request: NextRequest) {
  try {
    // Get user from auth
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.replace('Bearer ', '')

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    })

    // Get current user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user's authorizations (RLS policy handles filtering)
    const { data: authorizations, error } = await supabase
      .from('trader_authorizations')
      .select('id, platform, trader_id, status, permissions, label, sync_frequency, last_verified_at, created_at')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })

    if (error) {
      logger.dbError('fetch-authorizations', error, { userId: user.id })
      return NextResponse.json(
        { error: 'Failed to fetch authorizations' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      authorizations: authorizations || [],
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/trader/authorize?id=<authorization_id>
 *
 * Revoke authorization
 */
export async function DELETE(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // Get user from auth
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.replace('Bearer ', '')

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    })

    // Get current user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get authorization ID from query
    const { searchParams } = new URL(request.url)
    const authorizationId = searchParams.get('id')

    if (!authorizationId) {
      return NextResponse.json(
        { error: 'Missing authorization ID' },
        { status: 400 }
      )
    }

    // Revoke authorization (RLS policy handles ownership check)
    const { error } = await supabase
      .from('trader_authorizations')
      .update({
        status: 'revoked',
        updated_at: new Date().toISOString(),
      })
      .eq('id', authorizationId)
      .eq('user_id', user.id)

    if (error) {
      logger.dbError('revoke-authorization', error, {
        userId: user.id,
        authorizationId,
      })
      return NextResponse.json(
        { error: 'Failed to revoke authorization' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: 'Authorization revoked',
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

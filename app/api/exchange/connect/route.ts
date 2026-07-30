/**
 * 连接交易所API
 * POST /api/exchange/connect
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, forbidden, serverError } from '@/lib/api/response'
import { SUPPORTED_EXCHANGES, type Exchange } from '@/lib/exchange'
import { exchangeApiConnectionSaveResultSchema } from '@/lib/exchange/api-key-lifecycle'
import { encrypt } from '@/lib/exchange/encryption'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { validateExchangeReadOnlyAccess } from '@/lib/validators/api-key-validator'

const logger = createLogger('exchange-connect')

// Zod schema for POST /api/exchange/connect
const ConnectExchangeSchema = z.object({
  exchange: z.string().refine((val) => SUPPORTED_EXCHANGES.includes(val as Exchange), {
    message: `exchange must be one of: ${SUPPORTED_EXCHANGES.join(', ')}`,
  }),
  apiKey: z.string().min(10, 'API Key must be at least 10 characters'),
  apiSecret: z.string().min(10, 'API Secret must be at least 10 characters'),
  passphrase: z.string().optional().nullable(),
})

export const POST = withAuth(
  async ({ user, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    // Zod 输入验证
    const parsed = ConnectExchangeSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { exchange, apiKey, apiSecret } = parsed.data
    const passphrase = parsed.data.passphrase ?? null

    // Bitget 需要 passphrase
    if (exchange === 'bitget' && !passphrase) {
      return badRequest('Bitget requires a passphrase')
    }

    // The exchange itself must prove this exact key has no write capability
    // before Arena stores any encrypted copy of it.
    let verifiedPermissions: string[]
    try {
      const validation = await validateExchangeReadOnlyAccess(exchange, {
        apiKey,
        apiSecret,
        passphrase: passphrase ?? undefined,
      })

      if (!validation.isValid) {
        return badRequest(
          validation.error || 'Could not verify that this API key is valid and read-only.'
        )
      }
      verifiedPermissions = validation.permissions || ['read']
    } catch (err: unknown) {
      logger.error('验证凭证失败', { error: err, exchange, userId: user.id })
      return badRequest('Could not verify that this API key is valid and read-only.')
    }

    // 加密存储凭证
    const encryptedApiKey = encrypt(apiKey)
    const encryptedSecret = encrypt(apiSecret)
    const encryptedPassphrase = passphrase ? encrypt(passphrase) : null
    const adminSupabase = getSupabaseAdmin()

    // Credential validation happens outside PostgreSQL. Re-enter through the
    // account lifecycle authority so a concurrent ban/delete cannot land
    // between validation and an active credential write.
    const { data: saveResult, error: saveError } = await adminSupabase.rpc(
      'upsert_exchange_api_connection_for_active_profile_atomic',
      {
        p_user_id: user.id,
        p_exchange: exchange,
        p_api_key_encrypted: encryptedApiKey,
        p_api_secret_encrypted: encryptedSecret,
        p_passphrase_encrypted: encryptedPassphrase,
        p_verified_uid: null,
        p_scope_permissions: verifiedPermissions,
      }
    )

    if (saveError) {
      logger.error('Atomic connection persistence failed', {
        code: saveError.code,
        exchange,
        userId: user.id,
      })
      return serverError('Failed to persist connection')
    }

    const parsedSave = exchangeApiConnectionSaveResultSchema.safeParse(saveResult)
    if (!parsedSave.success) {
      logger.error('Atomic connection persistence returned an invalid acknowledgement', {
        exchange,
        userId: user.id,
      })
      return serverError('Failed to persist connection')
    }

    if (parsedSave.data.status === 'suspended' || parsedSave.data.status === 'missing_account') {
      return forbidden('Account unavailable')
    }
    if (
      parsedSave.data.status !== 'saved' ||
      parsedSave.data.user_id !== user.id ||
      parsedSave.data.exchange !== exchange ||
      parsedSave.data.verified
    ) {
      logger.error('Atomic connection persistence was rejected', {
        status: parsedSave.data.status,
        exchange,
        userId: user.id,
      })
      return serverError('Failed to persist connection')
    }

    return NextResponse.json({
      success: true,
      data: {
        viewerId: parsedSave.data.user_id,
        exchange: parsedSave.data.exchange,
        message: `Successfully connected to ${exchange}. Syncing data...`,
      },
    })
  },
  {
    name: 'exchange-connect',
    rateLimit: 'sensitive',
  }
)

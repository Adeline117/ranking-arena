/**
 * 连接交易所API
 * POST /api/exchange/connect
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { validateExchangeCredentials, SUPPORTED_EXCHANGES, type Exchange } from '@/lib/exchange'
import { encrypt } from '@/lib/exchange/encryption'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

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

    // 验证 API 凭证
    try {
      const isValid = await validateExchangeCredentials(exchange as Exchange, {
        apiKey,
        apiSecret,
        passphrase: passphrase ?? undefined,
      })

      if (!isValid) {
        return badRequest('Invalid API Key or Secret. Please check your credentials.')
      }
    } catch (err: unknown) {
      logger.error('验证凭证失败', { error: err, exchange, userId: user.id })
      const message = err instanceof Error ? err.message : 'API credential verification failed'
      return badRequest(message)
    }

    // 加密存储凭证
    const encryptedApiKey = encrypt(apiKey)
    const encryptedSecret = encrypt(apiSecret)
    const encryptedPassphrase = passphrase ? encrypt(passphrase) : null
    const adminSupabase = getSupabaseAdmin()

    const connectionData = {
      user_id: user.id,
      exchange,
      api_key_encrypted: encryptedApiKey,
      api_secret_encrypted: encryptedSecret,
      is_active: true,
      last_sync_status: 'pending',
      updated_at: new Date().toISOString(),
      ...(encryptedPassphrase ? { passphrase_encrypted: encryptedPassphrase } : {}),
    }

    // One statement is the persistence authority. A read-then-update/insert
    // sequence races concurrent reconnects, and an update that matched zero
    // rows could previously still return a false success to the client.
    const { data: savedConnection, error: saveError } = await adminSupabase
      .from('user_exchange_connections')
      .upsert(connectionData, { onConflict: 'user_id,exchange' })
      .select('user_id, exchange')
      .single()

    if (
      saveError ||
      savedConnection?.user_id !== user.id ||
      savedConnection.exchange !== exchange
    ) {
      throw new Error('Failed to persist connection')
    }

    return NextResponse.json({
      success: true,
      data: {
        viewerId: savedConnection.user_id,
        exchange: savedConnection.exchange,
        message: `Successfully connected to ${exchange}. Syncing data...`,
      },
    })
  },
  {
    name: 'exchange-connect',
    rateLimit: 'sensitive',
  }
)

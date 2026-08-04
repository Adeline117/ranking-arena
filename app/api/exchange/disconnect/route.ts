/**
 * DELETE /api/exchange/disconnect
 *
 * Revokes one current viewer/exchange connection and returns a bound receipt.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { API_KEY_CONNECTION_PLATFORMS } from '@/lib/exchange/read-only-platforms'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('exchange-disconnect')

export const dynamic = 'force-dynamic'

const DisconnectBodySchema = z.object({ exchange: z.enum(API_KEY_CONNECTION_PLATFORMS) }).strict()

const DisconnectedRowSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    exchange: z.enum(API_KEY_CONNECTION_PLATFORMS),
    is_active: z.literal(false),
  })
  .strict()

export const DELETE = withAuth(
  async ({ user, request }) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsedBody = DisconnectBodySchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid exchange request' }, { status: 400 })
    }
    const { exchange } = parsedBody.data

    // The generation trigger advances whenever is_active changes, fencing any
    // in-flight sync before its outcome can be recorded against this credential.
    const { data, error } = await getSupabaseAdmin()
      .from('user_exchange_connections')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('exchange', exchange)
      .select('id, user_id, exchange, is_active')
      .maybeSingle()

    if (error) {
      logger.error('Failed to disconnect exchange connection', {
        code: error.code,
        userId: user.id,
        exchange,
      })
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }

    if (data === null) {
      return NextResponse.json({ error: 'Exchange connection not found' }, { status: 404 })
    }

    const disconnected = DisconnectedRowSchema.safeParse(data)
    if (
      !disconnected.success ||
      disconnected.data.user_id !== user.id ||
      disconnected.data.exchange !== exchange
    ) {
      logger.error('Exchange disconnect returned a missing or mismatched acknowledgement', {
        userId: user.id,
        exchange,
      })
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }

    logger.info('Exchange connection disconnected', { userId: user.id, exchange })
    return NextResponse.json({ success: true, exchange })
  },
  { name: 'exchange-disconnect', rateLimit: 'sensitive' }
)

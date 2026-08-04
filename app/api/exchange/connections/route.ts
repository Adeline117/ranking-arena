import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { error, success } from '@/lib/api/response'
import { API_KEY_CONNECTION_PLATFORMS } from '@/lib/exchange/read-only-platforms'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('exchange-connections')

const ConnectionRowSchema = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    exchange: z.enum(API_KEY_CONNECTION_PLATFORMS),
    is_active: z.boolean(),
    last_sync_at: z.string().datetime({ offset: true }).nullable(),
    last_sync_status: z.enum(['success', 'error', 'pending']).nullable(),
    last_sync_error: z.string().max(500).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()

const ConnectionRowsSchema = z.array(ConnectionRowSchema).max(API_KEY_CONNECTION_PLATFORMS.length)

// Credentials and OAuth tokens deliberately never cross this response
// boundary. Browser clients receive only the fields rendered by Settings.
export const GET = withAuth(
  async ({ user }) => {
    const { data, error: queryError } = await getSupabaseAdmin()
      .from('user_exchange_connections')
      .select(
        'id, user_id, exchange, is_active, last_sync_at, last_sync_status, last_sync_error, created_at, updated_at'
      )
      .eq('user_id', user.id)
      .in('exchange', API_KEY_CONNECTION_PLATFORMS)
      .order('created_at', { ascending: false })

    if (queryError) {
      logger.error('Failed to load safe exchange connections', {
        userId: user.id,
        error: queryError,
      })
      return error('Failed to load exchange connections', 500)
    }

    const parsedRows = ConnectionRowsSchema.safeParse(data ?? [])
    if (!parsedRows.success) {
      logger.error('Exchange connection query returned an invalid safe-field projection', {
        userId: user.id,
      })
      return error('Failed to load exchange connections', 500)
    }

    const rows = parsedRows.data
    if (
      rows.some((connection) => connection.user_id !== user.id) ||
      new Set(rows.map((connection) => connection.exchange)).size !== rows.length
    ) {
      logger.error('Exchange connection query returned an invalid owner-bound projection', {
        userId: user.id,
      })
      return error('Failed to load exchange connections', 500)
    }

    return success({ connections: rows })
  },
  { name: 'exchange-connections', rateLimit: 'read' }
)

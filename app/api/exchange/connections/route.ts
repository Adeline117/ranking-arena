import { withAuth } from '@/lib/api/middleware'
import { error, success } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('exchange-connections')

// Credentials and OAuth tokens deliberately never cross this response
// boundary. Browser clients receive only the fields rendered by Settings.
export const GET = withAuth(
  async ({ user, supabase }) => {
    const { data, error: queryError } = await supabase
      .from('user_exchange_connections')
      .select(
        'id, user_id, exchange, is_active, last_sync_at, last_sync_status, last_sync_error, created_at, updated_at'
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (queryError) {
      logger.error('Failed to load safe exchange connections', {
        userId: user.id,
        error: queryError,
      })
      return error('Failed to load exchange connections', 500)
    }

    return success({ connections: data ?? [] })
  },
  { name: 'exchange-connections', rateLimit: 'read' }
)

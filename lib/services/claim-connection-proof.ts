import type { SupabaseClient } from '@supabase/supabase-js'

export function claimConnectionExchange(source: string): string {
  return source
    .trim()
    .toLowerCase()
    .replace(/_(futures|spot)$/, '')
}

export async function hasVerifiedClaimConnection(
  supabase: SupabaseClient,
  userId: string,
  source: string,
  traderId: string
): Promise<boolean> {
  const { data: connection, error } = await supabase
    .from('user_exchange_connections')
    .select('verified_uid, last_verified_at, scope_permissions')
    .eq('user_id', userId)
    .eq('exchange', claimConnectionExchange(source))
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error

  return Boolean(
    connection?.verified_uid &&
    String(connection.verified_uid) === String(traderId) &&
    connection.last_verified_at &&
    Array.isArray(connection.scope_permissions) &&
    connection.scope_permissions.length > 0
  )
}

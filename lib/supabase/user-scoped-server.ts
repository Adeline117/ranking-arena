import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'
import type { Database } from './database.types'

const USER_QUERY_TIMEOUT_MS = 15_000

/**
 * Build a non-persistent server client that forwards the already-verified user
 * JWT. This is intentionally separate from getSupabaseAdmin(): read routes that
 * depend on auth.uid() RLS must never silently execute as service_role.
 */
export function createUserScopedServerClient(
  request: Pick<NextRequest, 'headers'>
): SupabaseClient<Database> {
  const authorization = request.headers.get('authorization')
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    throw new Error('A verified bearer token is required for an RLS-scoped query')
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error('Supabase URL and anonymous key are required for an RLS-scoped query')
  }

  return createClient<Database>(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { Authorization: authorization },
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(USER_QUERY_TIMEOUT_MS),
        }),
    },
  })
}

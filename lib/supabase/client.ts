// lib/supabase/client.ts
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import {
  detectAuthSessionInUrl,
  guardedAuthStorage,
  settleAuthRedirectInitialization,
} from '@/lib/auth/session-operation'

// Singleton — created once on first access to avoid multiple GoTrue instances.
// The module is eagerly imported by Next.js so we keep createClient() cheap:
// it is synchronous and sets up the client in-memory; network requests only
// happen when methods like .auth.getUser() or .from().select() are called.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key'

export const supabase: SupabaseClient<Database> = createClient<Database>(url, anon, {
  auth: {
    persistSession: true,
    storageKey: 'arena-auth',
    storage: typeof window !== 'undefined' ? guardedAuthStorage : undefined,
    // Refreshes must pass through tokenRefreshCoordinator so their principal
    // lease is checked at the actual localStorage write boundary.
    autoRefreshToken: false,
    detectSessionInUrl: detectAuthSessionInUrl,
  },
  global: {
    // 15s timeout on all client-side Supabase requests — prevents UI hangs when
    // Supabase is slow/degraded. Matches the 15s timeout in useSWR.ts fetcher.
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? AbortSignal.timeout(15_000)
      return fetch(input, { ...init, signal })
    },
  },
})

// createClient starts initialize() in its constructor. Observe that same
// promise so an invalid/reused recovery URL rolls its provisional lease back
// to the previously stored principal instead of leaving auth pending forever.
void supabase.auth
  .initialize()
  .then(settleAuthRedirectInitialization, settleAuthRedirectInitialization)

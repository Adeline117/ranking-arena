/**
 * Shared utility for extracting the authenticated user from a request.
 * Supports both Bearer token and cookie-based auth.
 *
 * Consolidates the pattern duplicated across 9+ API routes.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createClient } from '@supabase/supabase-js'
import type { User } from '@supabase/supabase-js'

export async function extractUserFromRequest(request: Request): Promise<{
  user: User | null
  error: string | null
}> {
  const authHeader = request.headers.get('authorization')

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    const { data, error } = await getSupabaseAdmin().auth.getUser(token)
    return { user: data?.user ?? null, error: error?.message ?? null }
  }

  // Fallback to cookie auth
  const cookieHeader = request.headers.get('cookie') || ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!anonKey || !supabaseUrl) {
    return { user: null, error: 'Server configuration error' }
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { cookie: cookieHeader } },
    auth: { persistSession: false, detectSessionInUrl: false },
  })
  const { data, error } = await supabase.auth.getUser()
  return { user: data?.user ?? null, error: error?.message ?? null }
}

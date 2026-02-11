/**
 * Shared Supabase client for import scripts
 */
import { createClient } from '@supabase/supabase-js'
import './env.mjs'

export const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

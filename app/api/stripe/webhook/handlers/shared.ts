import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

export const logger = createLogger('stripe-webhook')

// Lazy-loaded Supabase Admin client
let _supabaseInstance: SupabaseClient | null = null
export function getSupabase() {
  if (!_supabaseInstance) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) {
      throw new Error('Supabase credentials not configured (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)')
    }
    _supabaseInstance = createClient(url, serviceKey, {
      auth: { persistSession: false },
    })
  }
  return _supabaseInstance
}

// Retry wrapper for database operations
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 1000
): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation()
    } catch (error: unknown) {
      lastError = error as Error
      logger.warn(`Retry ${i + 1}/${maxRetries} failed`, { error })
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)))
      }
    }
  }
  throw lastError
}

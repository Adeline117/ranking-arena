import { createLogger } from '@/lib/utils/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export const logger = createLogger('stripe-webhook')

export const getSupabase = () => getSupabaseAdmin() as SupabaseClient

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

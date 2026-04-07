/**
 * Supabase Retry Utility
 * 
 * Handles transient Supabase errors (502 Bad Gateway from Cloudflare)
 * with exponential backoff retry logic.
 * 
 * Emergency fix 2026-04-01: Handle Supabase 502 errors during high load
 */

import { SupabaseClient, PostgrestResponse } from '@supabase/supabase-js'
import { dataLogger } from './logger'

interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffFactor?: number
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffFactor: 2,
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableError(error: unknown): boolean {
  if (!error) return false

  const err = error as Record<string, unknown>
  const message = String(err.message || err.error || error)
  const code = err.code || err.status || err.statusCode

  // Cloudflare 502 Bad Gateway
  if (code === 502 || message.includes('502') || message.includes('Bad gateway')) {
    return true
  }

  // Other transient errors
  if (code === 503 || message.includes('503') || message.includes('Service unavailable')) {
    return true
  }

  if (code === 504 || message.includes('504') || message.includes('Gateway timeout')) {
    return true
  }

  // PostgreSQL statement timeout (57014) — can be transient under load
  if (code === '57014' || message.includes('57014') || message.includes('statement timeout')) {
    return true
  }

  // Network errors
  if (message.includes('ECONNRESET') || message.includes('ETIMEDOUT')) {
    return true
  }

  return false
}

/**
 * Retry a Supabase query operation with exponential backoff
 * 
 * @param operation Function that returns a Supabase query builder
 * @param options Retry configuration
 * @returns Query result
 * 
 * @example
 * const result = await retrySupabaseQuery(
 *   () => supabase.from('traders').upsert(data),
 *   { maxAttempts: 3 }
 * )
 */
export async function retrySupabaseQuery<T>(
  operation: () => Promise<PostgrestResponse<T>>,
  options: RetryOptions = {}
): Promise<PostgrestResponse<T>> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  let lastError: unknown
  let delay = opts.initialDelayMs
  
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const result = await operation()
      
      // Check for error in response
      if (result.error) {
        if (isRetryableError(result.error) && attempt < opts.maxAttempts) {
          dataLogger.warn(`[supabase-retry] Attempt ${attempt}/${opts.maxAttempts} failed with retryable error, retrying in ${delay}ms...`, {
            error: result.error.message,
            code: result.error.code,
          })
          await sleep(delay)
          delay = Math.min(delay * opts.backoffFactor, opts.maxDelayMs)
          lastError = result.error
          continue
        }
        // Non-retryable error or final attempt
        return result
      }
      
      // Success
      if (attempt > 1) {
        dataLogger.info(`[supabase-retry] Succeeded on attempt ${attempt}/${opts.maxAttempts}`)
      }
      return result
      
    } catch (error) {
      if (isRetryableError(error) && attempt < opts.maxAttempts) {
        dataLogger.warn(`[supabase-retry] Attempt ${attempt}/${opts.maxAttempts} threw retryable error, retrying in ${delay}ms...`, {
          error: error instanceof Error ? error.message : String(error),
        })
        await sleep(delay)
        delay = Math.min(delay * opts.backoffFactor, opts.maxDelayMs)
        lastError = error
        continue
      }
      // Non-retryable error or final attempt
      throw error
    }
  }
  
  // All retries exhausted
  throw lastError || new Error('All retry attempts exhausted')
}

/**
 * Retry wrapper for Supabase insert operations
 */
export async function retryInsert<T>(
  client: SupabaseClient,
  table: string,
  data: T | T[],
  options: RetryOptions = {}
): Promise<PostgrestResponse<T>> {
  return retrySupabaseQuery<T>(
    async () => await client.from(table).insert(data as any) as PostgrestResponse<T>,
    options
  )
}

/**
 * Retry wrapper for Supabase upsert operations
 */
export async function retryUpsert<T>(
  client: SupabaseClient,
  table: string,
  data: T | T[],
  upsertOptions?: { onConflict?: string },
  retryOptions: RetryOptions = {}
): Promise<PostgrestResponse<T>> {
  return retrySupabaseQuery<T>(
    async () => await client.from(table).upsert(data as any, upsertOptions) as PostgrestResponse<T>,
    retryOptions
  )
}

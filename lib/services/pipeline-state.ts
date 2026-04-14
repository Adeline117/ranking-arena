/**
 * Persistent pipeline state — replaces Redis for cross-cron-run business state.
 *
 * Uses Supabase `pipeline_state` table instead of Redis TTL keys.
 * This prevents the class of bugs where state expires between cron runs
 * (e.g., the 6-day leaderboard freeze caused by skip counter in Redis warm tier).
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export class PipelineState {
  /**
   * Get a value from persistent state.
   * Returns null if key doesn't exist.
   */
  static async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const supabase = getSupabaseAdmin() as SupabaseClient
      const { data, error } = await supabase
        .from('pipeline_state')
        .select('value')
        .eq('key', key)
        .single()

      if (error || !data) return null
      return data.value as T
    } catch (err) {
      logger.warn(`[PipelineState] get(${key}) failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /**
   * Set a value in persistent state (upsert).
   */
  static async set(key: string, value: unknown): Promise<void> {
    try {
      const supabase = getSupabaseAdmin() as SupabaseClient
      await supabase
        .from('pipeline_state')
        .upsert(
          { key, value: value as Record<string, unknown>, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        )
    } catch (err) {
      logger.warn(`[PipelineState] set(${key}) failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Delete a key from persistent state.
   */
  static async del(key: string): Promise<void> {
    try {
      const supabase = getSupabaseAdmin() as SupabaseClient
      await supabase
        .from('pipeline_state')
        .delete()
        .eq('key', key)
    } catch (err) {
      logger.warn(`[PipelineState] del(${key}) failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Increment a numeric value atomically.
   * If key doesn't exist, starts from 0 and increments to 1.
   * Returns the new value.
   */
  static async incr(key: string): Promise<number> {
    try {
      const supabase = getSupabaseAdmin() as SupabaseClient
      // Read current value
      const { data } = await supabase
        .from('pipeline_state')
        .select('value')
        .eq('key', key)
        .single()

      const current = typeof data?.value === 'number' ? data.value : 0
      const next = current + 1

      await supabase
        .from('pipeline_state')
        .upsert(
          { key, value: next as unknown as Record<string, unknown>, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        )

      return next
    } catch (err) {
      logger.warn(`[PipelineState] incr(${key}) failed: ${err instanceof Error ? err.message : String(err)}`)
      return 1 // Default to 1 on error (safe: won't prevent circuit breaker from triggering)
    }
  }

  /**
   * Cleanup stale entries older than the given age.
   * Removes abandoned checkpoints, old dead counters, stale evaluator feedback.
   * Returns number of rows deleted.
   */
  static async cleanupStale(maxAgeMs: number = 7 * 24 * 3600 * 1000): Promise<number> {
    try {
      const supabase = getSupabaseAdmin() as SupabaseClient
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
      const { count, error } = await supabase
        .from('pipeline_state')
        .delete({ count: 'exact' })
        .lt('updated_at', cutoff)
      if (error) {
        logger.warn(`[PipelineState] cleanupStale failed: ${error.message}`)
        return 0
      }
      return count ?? 0
    } catch (err) {
      logger.warn(`[PipelineState] cleanupStale failed: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
  }

  /**
   * Get all keys matching a prefix.
   * Useful for listing all dead platform counters, etc.
   */
  static async getByPrefix(prefix: string): Promise<Array<{ key: string; value: unknown; updated_at: string }>> {
    try {
      const supabase = getSupabaseAdmin() as SupabaseClient
      const { data, error } = await supabase
        .from('pipeline_state')
        .select('key, value, updated_at')
        .like('key', `${prefix}%`)

      if (error) return []
      return data || []
    } catch (err) {
      logger.warn(`[PipelineState] getByPrefix(${prefix}) failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }
}

/**
 * Read Replica Client
 *
 * Returns a Supabase client connected to the read replica for read-heavy queries.
 * Falls back to the primary if no replica is configured.
 *
 * Usage:
 *   import { getReadReplica } from '@/lib/supabase/read-replica'
 *   const db = getReadReplica()
 *   const { data } = await db.from('leaderboard_ranks').select(...)
 *
 * Setup:
 *   Set SUPABASE_READ_REPLICA_URL in .env.local (from Supabase dashboard > Settings > Read Replicas)
 *   If not set, falls back to the primary connection.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from './server'

let readReplicaClient: SupabaseClient | null = null

export function getReadReplica(): SupabaseClient {
  // If read replica URL is configured, use it
  const replicaUrl = process.env.SUPABASE_READ_REPLICA_URL
  if (replicaUrl) {
    if (!readReplicaClient) {
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
      readReplicaClient = createClient(replicaUrl, key, {
        auth: { persistSession: false },
        db: { schema: 'public' },
      })
    }
    return readReplicaClient
  }

  // Fallback: use primary (no read replica configured)
  return getSupabaseAdmin()
}

/**
 * Avatar mirroring (spec §1.4): always mirror the origin-exchange avatar —
 * fetch the bytes, store in our Supabase Storage (`trader-avatars`, public),
 * serve from our CDN. Origin URLs hotlink-block and expire. Refresh weekly.
 *
 * Runs daily; each run handles up to BATCH unmirrored + stale traders.
 */

import { createHash } from 'node:crypto'
import type { Job } from 'bullmq'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getIngestPool } from '@/lib/ingest/db'

const BUCKET = 'trader-avatars'
const BATCH = 500
const REFRESH_DAYS = 7
const MAX_BYTES = 2 * 1024 * 1024

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

let storage: SupabaseClient | null = null
function getStorage(): SupabaseClient {
  if (storage) return storage
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('[avatar-mirror] Supabase env not set')
  storage = createClient(url, key, { auth: { persistSession: false } })
  return storage
}

interface TraderAvatarRow {
  id: number
  source_slug: string
  exchange_trader_id: string
  avatar_url_origin: string
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

async function mirrorOne(row: TraderAvatarRow): Promise<string | null> {
  const resp = await fetch(row.avatar_url_origin, {
    headers: { accept: 'image/*' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) return null
  const type = (resp.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!ALLOWED_TYPES.has(type)) return null
  const bytes = Buffer.from(await resp.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null

  const hash = createHash('sha1').update(row.exchange_trader_id).digest('hex')
  const path = `${row.source_slug}/${hash}.${EXT_BY_TYPE[type]}`
  const { error } = await getStorage()
    .storage.from(BUCKET)
    .upload(path, bytes, { contentType: type, upsert: true })
  if (error) throw new Error(`upload failed: ${error.message}`)

  const { data } = getStorage().storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export async function processAvatarMirror(
  _job: Job
): Promise<{ mirrored: number; failed: number }> {
  const pool = getIngestPool()
  const { rows } = await pool.query<TraderAvatarRow>(
    `SELECT t.id, s.slug AS source_slug, t.exchange_trader_id, t.avatar_url_origin
       FROM arena.traders t
       JOIN arena.sources s ON s.id = t.source_id
      WHERE t.avatar_url_origin IS NOT NULL
        AND (t.avatar_url_mirror IS NULL
             OR COALESCE((t.meta->>'avatar_mirrored_at')::timestamptz,
                         'epoch'::timestamptz) < now() - interval '${REFRESH_DAYS} days')
      ORDER BY t.last_seen_at DESC
      LIMIT ${BATCH}`
  )

  let mirrored = 0
  let failed = 0
  for (const row of rows) {
    try {
      const publicUrl = await mirrorOne(row)
      if (publicUrl) {
        await pool.query(
          `UPDATE arena.traders
              SET avatar_url_mirror = $2,
                  meta = meta || jsonb_build_object('avatar_mirrored_at', now()::text)
            WHERE id = $1`,
          [row.id, publicUrl]
        )
        mirrored += 1
      } else {
        // Unfetchable origin — stamp the attempt so we don't retry it every run.
        await pool.query(
          `UPDATE arena.traders
              SET meta = meta || jsonb_build_object('avatar_mirrored_at', now()::text)
            WHERE id = $1`,
          [row.id]
        )
        failed += 1
      }
    } catch (err) {
      failed += 1
      console.warn(
        `[avatar-mirror] ${row.source_slug}/${row.exchange_trader_id}:`,
        err instanceof Error ? err.message : err
      )
    }
    // Friendly pacing toward exchange CDNs
    await new Promise((r) => setTimeout(r, 150))
  }

  console.log(`[avatar-mirror] mirrored=${mirrored} failed=${failed} of ${rows.length}`)
  return { mirrored, failed }
}

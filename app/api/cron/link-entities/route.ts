/**
 * Cross-platform entity linking cron job.
 *
 * Finds DEX traders who share the same wallet address across multiple platforms.
 * Groups by lowercase address and identifies addresses appearing on 2+ platforms.
 *
 * Schedule: daily (see vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const logger = createLogger('link-entities')

export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface LinkedEntity {
  address: string
  platforms: string[]
  trader_keys: string[]
  count: number
}

export async function GET(request: NextRequest) {
  // Verify cron secret (timing-safe)
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('link-entities')

  try {
    const supabase = getSupabaseAdmin() as SupabaseClient

    // Fetch all traders with 0x wallet addresses (DEX traders)
    // Use trader_snapshots_v2 which has the freshest data across all platforms
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key')
      .like('trader_key', '0x%')

    if (error) {
      logger.error('Failed to fetch traders:', error.message)
      await plog.error(error)
      return NextResponse.json({ error: 'Failed to fetch traders' }, { status: 500 })
    }

    if (!data || data.length === 0) {
      await plog.success(0)
      return NextResponse.json({ linked: [], total_addresses: 0, multi_platform: 0 })
    }

    // Group by lowercase address
    const addressMap = new Map<string, Map<string, string>>()
    for (const t of data) {
      if (!t.trader_key || !t.platform) continue
      const addr = t.trader_key.toLowerCase()
      if (!addressMap.has(addr)) addressMap.set(addr, new Map())
      // Use Map to deduplicate platform entries per address
      addressMap.get(addr)!.set(t.platform, t.trader_key)
    }

    // Find addresses appearing on 2+ platforms
    const linked: LinkedEntity[] = []
    for (const [address, platformMap] of addressMap) {
      if (platformMap.size < 2) continue
      linked.push({
        address,
        platforms: Array.from(platformMap.keys()),
        trader_keys: Array.from(platformMap.values()),
        count: platformMap.size,
      })
    }

    // Sort by most platforms first
    linked.sort((a, b) => b.count - a.count)

    // Upsert to linked_entities table if it exists, otherwise just return the data
    let upsertCount = 0
    try {
      // Attempt to upsert — if the table does not exist this will fail gracefully
      const upsertRows = linked.map((entity) => ({
        address: entity.address,
        platforms: entity.platforms,
        trader_keys: entity.trader_keys,
        platform_count: entity.count,
        updated_at: new Date().toISOString(),
      }))

      if (upsertRows.length > 0) {
        const { error: upsertError } = await supabase
          .from('linked_entities')
          .upsert(upsertRows, { onConflict: 'address' })

        if (upsertError) {
          // Table may not exist yet — log but do not fail the job
          logger.warn('linked_entities upsert skipped (table may not exist):', upsertError.message)
        } else {
          upsertCount = upsertRows.length
        }
      }
    } catch {
      // Intentionally swallowed: table may not exist yet
      logger.warn('linked_entities table not available, returning results as API response only')
    }

    const summary = {
      total_addresses: addressMap.size,
      multi_platform: linked.length,
      upserted: upsertCount,
      top_linked: linked.slice(0, 20),
    }

    logger.info(`Entity linking complete: ${addressMap.size} addresses, ${linked.length} multi-platform`)
    await plog.success(linked.length)

    return NextResponse.json(summary)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    logger.error('Entity linking failed:', err.message)
    await plog.error(err)
    return NextResponse.json({ error: 'Entity linking failed' }, { status: 500 })
  }
}

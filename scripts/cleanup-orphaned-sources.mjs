#!/usr/bin/env node
/**
 * Cleanup orphaned trader_sources entries
 *
 * Finds trader_sources rows that have no corresponding trader_snapshots
 * and removes them. Run with --dry-run to preview without deleting.
 *
 * Usage:
 *   node scripts/cleanup-orphaned-sources.mjs --dry-run
 *   node scripts/cleanup-orphaned-sources.mjs --delete
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

const isDryRun = !process.argv.includes('--delete')

async function main() {
  console.log(`=== Cleanup Orphaned trader_sources (${isDryRun ? 'DRY RUN' : 'DELETE MODE'}) ===\n`)

  // Find orphaned trader_sources using a LEFT JOIN via RPC
  // Since Supabase JS doesn't support LEFT JOIN, use raw SQL via rpc or paginated approach
  const PAGE_SIZE = 1000
  let page = 0
  let totalOrphaned = 0
  let totalDeleted = 0
  const orphanedBySource = {}

  while (true) {
    const { data: sources, error } = await supabase
      .from('trader_sources')
      .select('id, source, source_trader_id')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    if (error) {
      console.error(`Error fetching page ${page}:`, error.message)
      break
    }

    if (!sources || sources.length === 0) break

    // Check which of these have snapshots (batch lookup)
    const keys = sources.map(s => `${s.source}:${s.source_trader_id}`)

    // Check in batches of 100
    const orphaned = []
    for (let i = 0; i < sources.length; i += 100) {
      const batch = sources.slice(i, i + 100)

      // For each source in batch, check if any snapshot exists
      for (const src of batch) {
        const { count, error: countErr } = await supabase
          .from('trader_snapshots')
          .select('id', { count: 'exact', head: true })
          .eq('source', src.source)
          .eq('source_trader_id', src.source_trader_id)
          .limit(1)

        if (countErr) {
          console.error(`Error checking ${src.source}/${src.source_trader_id}:`, countErr.message)
          continue
        }

        if (count === 0) {
          orphaned.push(src)
          orphanedBySource[src.source] = (orphanedBySource[src.source] || 0) + 1
        }
      }
    }

    totalOrphaned += orphaned.length

    if (!isDryRun && orphaned.length > 0) {
      const ids = orphaned.map(o => o.id)
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100)
        const { error: delErr } = await supabase
          .from('trader_sources')
          .delete()
          .in('id', batch)

        if (delErr) {
          console.error(`Delete error:`, delErr.message)
        } else {
          totalDeleted += batch.length
        }
      }
    }

    console.log(`Page ${page}: checked ${sources.length}, found ${orphaned.length} orphaned`)

    if (sources.length < PAGE_SIZE) break
    page++
  }

  console.log('\n=== Summary ===')
  console.log(`Total orphaned: ${totalOrphaned}`)
  if (!isDryRun) {
    console.log(`Total deleted: ${totalDeleted}`)
  }

  if (Object.keys(orphanedBySource).length > 0) {
    console.log('\nOrphaned by source:')
    for (const [source, count] of Object.entries(orphanedBySource).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${source}: ${count}`)
    }
  }

  if (isDryRun && totalOrphaned > 0) {
    console.log('\nRun with --delete to remove orphaned entries')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

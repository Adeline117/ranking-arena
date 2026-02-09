#!/usr/bin/env node
/**
 * backfill-avatars-dicebear.mjs
 * Fill remaining null avatars with DiceBear generated avatars.
 * Uses "bottts-neutral" style for CEX traders (looks like robot/profile pics).
 * These are deterministic - same seed always generates same avatar.
 * 
 * Usage: node scripts/backfill-avatars-dicebear.mjs [--dry-run] [--source=xxx]
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

function avatarUrl(source, traderId, handle) {
  const seed = handle || traderId
  // Use different styles per category
  if (source.includes('web3') || ['hyperliquid','gmx','gains','dydx','jupiter_perps','aevo'].includes(source)) {
    // Already handled by the main script
    return traderId?.startsWith('0x')
      ? `https://effigy.im/a/${traderId.toLowerCase()}.svg`
      : `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(seed)}`
  }
  // CEX traders get bottts-neutral (cute robot faces)
  return `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${encodeURIComponent(seed)}`
}

async function main() {
  console.log(`\n🤖 DiceBear Avatar Backfill ${DRY_RUN ? '(DRY RUN)' : ''}\n`)

  // Get all traders with missing avatars
  const all = []
  let from = 0
  const query = supabase.from('trader_sources').select('id, source, source_trader_id, handle').is('avatar_url', null)
  if (SOURCE_FILTER) query.eq('source', SOURCE_FILTER)

  while (true) {
    const q = supabase.from('trader_sources').select('id, source, source_trader_id, handle').is('avatar_url', null)
    if (SOURCE_FILTER) q.eq('source', SOURCE_FILTER)
    const { data, error } = await q.range(from, from + 999)
    if (error || !data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Found ${all.length} traders with missing avatars\n`)
  if (!all.length) return

  // Group by source for reporting
  const bySrc = {}
  for (const t of all) {
    if (!bySrc[t.source]) bySrc[t.source] = []
    bySrc[t.source].push(t)
  }

  let totalUpdated = 0
  for (const [source, traders] of Object.entries(bySrc).sort((a, b) => b[1].length - a[1].length)) {
    const updates = traders.map(t => ({
      id: t.id,
      avatar_url: avatarUrl(source, t.source_trader_id, t.handle)
    }))

    if (DRY_RUN) {
      console.log(`  ${source}: ${updates.length} would be updated`)
      totalUpdated += updates.length
      continue
    }

    let ok = 0
    const CONCURRENCY = 20
    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const batch = updates.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map(({ id, avatar_url }) =>
          supabase.from('trader_sources').update({ avatar_url }).eq('id', id)
        )
      )
      ok += results.filter(r => r.status === 'fulfilled' && !r.value.error).length
      if (i % 200 === 0 && i > 0) process.stdout.write(`  ${source}: ...${i}/${updates.length}\n`)
    }
    console.log(`  ✅ ${source}: ${ok}/${traders.length}`)
    totalUpdated += ok
  }

  console.log(`\n🎉 Total: ${totalUpdated} avatars filled`)

  // Final coverage
  const { count: total } = await supabase.from('trader_sources').select('*', { count: 'exact', head: true })
  const { count: missing } = await supabase.from('trader_sources').select('*', { count: 'exact', head: true }).is('avatar_url', null)
  console.log(`\n📊 Coverage: ${total - missing}/${total} (${((1 - missing / total) * 100).toFixed(1)}%)`)
  if (missing > 0) console.log(`   Still missing: ${missing}`)
}

main().catch(console.error)

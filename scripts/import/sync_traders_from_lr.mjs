#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('=== Sync traders from leaderboard_ranks ===')
  
  // Fetch all 90D traders
  let all = [], offset = 0
  while (true) {
    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, handle, avatar_url, roi, win_rate, followers')
      .eq('season_id', '90D')
      .range(offset, offset + 999)
    if (!data || !data.length) break
    all.push(...data)
    offset += 1000
  }
  
  // Dedupe
  const seen = new Map()
  for (const t of all) {
    const key = `${t.source}:${t.source_trader_id}`
    if (!seen.has(key)) seen.set(key, t)
  }
  const unique = [...seen.values()]
  console.log(`${unique.length} unique traders from 90D`)
  
  // Upsert in small batches via Supabase client
  let ok = 0, err = 0
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100).map(t => ({
      handle: (t.handle || t.source_trader_id || '').substring(0, 100),
      source: t.source,
      source_trader_id: t.source_trader_id,
      roi: t.roi ?? 0,
      win_rate: t.win_rate,
      followers: t.followers || 0,
      updated_at: new Date().toISOString(),
    }))
    
    const { error } = await supabase
      .from('traders')
      .upsert(batch, { onConflict: 'source,source_trader_id' })
    
    if (error) {
      err++
      if (err <= 3) console.error(`Batch ${i}: ${error.message}`)
    } else {
      ok += batch.length
    }
    if (i % 2000 === 0 && i > 0) console.log(`  ${i}/${unique.length}`)
  }
  
  const { count } = await supabase.from('traders').select('*', { count: 'exact', head: true })
  console.log(`\nDone! Upserted: ${ok}, Errors: ${err}`)
  console.log(`Traders table: ${count} rows`)
}

main().catch(console.error)

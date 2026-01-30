#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  // Get all sources
  const { data: allTraders } = await supabase
    .from('trader_sources')
    .select('source, avatar_url')

  const stats = {}

  for (const t of allTraders) {
    if (!stats[t.source]) {
      stats[t.source] = { total: 0, has_avatar: 0, missing: 0 }
    }
    stats[t.source].total++
    if (t.avatar_url) {
      stats[t.source].has_avatar++
    } else {
      stats[t.source].missing++
    }
  }

  const sorted = Object.entries(stats)
    .map(([source, s]) => ({
      source,
      total: s.total,
      has_avatar: s.has_avatar,
      missing: s.missing,
      coverage: ((s.has_avatar / s.total) * 100).toFixed(1)
    }))
    .sort((a, b) => b.missing - a.missing)

  console.log('\n📊 Avatar Coverage by Platform:\n')
  console.log('Platform'.padEnd(20), 'Total'.padStart(8), 'Has Avatar'.padStart(12), 'Missing'.padStart(10), 'Coverage'.padStart(10))
  console.log('-'.repeat(70))

  for (const s of sorted) {
    console.log(
      s.source.padEnd(20),
      s.total.toString().padStart(8),
      s.has_avatar.toString().padStart(12),
      s.missing.toString().padStart(10),
      (s.coverage + '%').padStart(10)
    )
  }

  const totals = sorted.reduce((acc, s) => ({
    total: acc.total + s.total,
    has_avatar: acc.has_avatar + s.has_avatar,
    missing: acc.missing + s.missing
  }), { total: 0, has_avatar: 0, missing: 0 })

  console.log('-'.repeat(70))
  console.log(
    'TOTAL'.padEnd(20),
    totals.total.toString().padStart(8),
    totals.has_avatar.toString().padStart(12),
    totals.missing.toString().padStart(10),
    ((totals.has_avatar / totals.total * 100).toFixed(1) + '%').padStart(10)
  )
}

main().catch(console.error)

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Query in batches to avoid row limits
const allRows = []
let page = 0
const PAGE_SIZE = 1000

while (true) {
  const { data, error } = await sb
    .from('trader_snapshots')
    .select('source, season_id')
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    .order('source')

  if (error) {
    console.error('Query error:', error.message)
    break
  }
  if (!data || data.length === 0) break
  allRows.push(...data)
  if (data.length < PAGE_SIZE) break
  page++
}

const grouped = {}
for (const r of allRows) {
  const k = `${r.source}|${r.season_id}`
  grouped[k] = (grouped[k] || 0) + 1
}

console.log('\n=== Current Data Counts ===')
for (const [k, v] of Object.entries(grouped).sort()) {
  console.log(`  ${k.padEnd(35)} ${v}`)
}
console.log(`\nTotal rows: ${allRows.length}`)

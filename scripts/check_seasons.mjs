#!/usr/bin/env node
/**
 * Check season (period) distribution across trader_snapshots.
 * Shows count per source x season_id combination.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '../.env.local')

try {
  for (const l of readFileSync(envPath, 'utf8').split('\n')) {
    const m = l.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function checkSeasons() {
  console.log('=== Season Distribution Check ===\n')

  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source, season_id')
    .limit(50000)

  if (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }

  if (!data || data.length === 0) {
    console.log('No snapshot data found.')
    return
  }

  // Count per source x season
  const matrix = {}
  const allSeasons = new Set()

  data.forEach(r => {
    const src = r.source || 'unknown'
    const season = r.season_id || 'null'
    allSeasons.add(season)
    if (!matrix[src]) matrix[src] = {}
    matrix[src][season] = (matrix[src][season] || 0) + 1
  })

  const seasons = [...allSeasons].sort()

  // Header
  const srcWidth = 20
  const colWidth = 8
  const header = 'Source'.padEnd(srcWidth) + seasons.map(s => s.padStart(colWidth)).join('')
  console.log(header)
  console.log('-'.repeat(header.length))

  // Rows sorted by source name
  const sources = Object.keys(matrix).sort()
  const seasonTotals = {}

  for (const src of sources) {
    let line = src.padEnd(srcWidth)
    for (const season of seasons) {
      const count = matrix[src][season] || 0
      seasonTotals[season] = (seasonTotals[season] || 0) + count
      line += String(count).padStart(colWidth)
    }
    console.log(line)
  }

  // Totals row
  console.log('-'.repeat(header.length))
  let totalsLine = 'TOTAL'.padEnd(srcWidth)
  let grandTotal = 0
  for (const season of seasons) {
    const t = seasonTotals[season] || 0
    grandTotal += t
    totalsLine += String(t).padStart(colWidth)
  }
  console.log(totalsLine)

  console.log(`\nSources: ${sources.length} | Seasons: ${seasons.join(', ')} | Total rows: ${grandTotal}`)

  // Flag sources missing seasons
  const expectedSeasons = ['7D', '30D', '90D']
  const incomplete = sources.filter(src =>
    expectedSeasons.some(s => !matrix[src][s])
  )

  if (incomplete.length > 0) {
    console.log('\nSources missing expected seasons (7D/30D/90D):')
    for (const src of incomplete) {
      const missing = expectedSeasons.filter(s => !matrix[src][s])
      console.log(`  ${src}: missing ${missing.join(', ')}`)
    }
  }

  console.log('\nDone.')
}

checkSeasons().catch(e => {
  console.error(e)
  process.exit(1)
})

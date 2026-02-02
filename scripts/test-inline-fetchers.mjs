/**
 * Test all inline fetchers — runs each platform with 30D period
 * Usage: npx tsx scripts/test-inline-fetchers.mjs [platform1 platform2 ...]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Import all fetchers (dynamic to handle .ts)
const { INLINE_FETCHERS } = await import('../lib/cron/fetchers/index.ts')

const allPlatforms = Object.keys(INLINE_FETCHERS).filter(k => 
  k !== 'htx_futures' // alias, skip
)

const targets = process.argv.slice(2).length > 0 
  ? process.argv.slice(2) 
  : allPlatforms

const results = []
const periods = ['7D', '30D', '90D'] // All periods for complete data

console.log(`\n${'='.repeat(60)}`)
console.log(`Testing ${targets.length} inline fetchers`)
console.log(`Periods: ${periods.join(', ')}`)
console.log(`${'='.repeat(60)}\n`)

for (const platform of targets) {
  const fetcher = INLINE_FETCHERS[platform]
  if (!fetcher) {
    console.log(`❓ ${platform}: not found in registry`)
    results.push({ platform, status: 'NOT_FOUND', total: 0, saved: 0, duration: 0 })
    continue
  }

  console.log(`⏳ ${platform}...`)
  const start = Date.now()

  try {
    const result = await fetcher(supabase, periods)
    const dur = ((Date.now() - start) / 1000).toFixed(1)
    
    let totalAll = 0, savedAll = 0
    const periodDetails = []
    for (const p of periods) {
      const pd = result.periods[p] || {}
      totalAll += pd.total || 0
      savedAll += pd.saved || 0
      periodDetails.push(`${p}:${pd.saved||0}/${pd.total||0}`)
    }
    
    if (totalAll > 0) {
      console.log(`✅ ${platform}: ${savedAll}/${totalAll} saved [${periodDetails.join(', ')}] (${dur}s)`)
      results.push({ platform, status: 'OK', total: totalAll, saved: savedAll, duration: dur })
    } else {
      const firstError = Object.values(result.periods).find(p => p.error)?.error
      console.log(`⚠️  ${platform}: 0 results${firstError ? ' — ' + firstError : ''} (${dur}s)`)
      results.push({ platform, status: 'EMPTY', total: 0, saved: 0, duration: dur, error: firstError })
    }
  } catch (e) {
    const dur = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`❌ ${platform}: ${e.message} (${dur}s)`)
    results.push({ platform, status: 'ERROR', total: 0, saved: 0, duration: dur, error: e.message })
  }
}

// Summary
console.log(`\n${'='.repeat(60)}`)
console.log('📊 Summary')
console.log(`${'='.repeat(60)}`)

const ok = results.filter(r => r.status === 'OK')
const empty = results.filter(r => r.status === 'EMPTY')
const err = results.filter(r => r.status === 'ERROR')

console.log(`\n✅ Working (${ok.length}):`)
for (const r of ok.sort((a,b) => b.total - a.total)) {
  console.log(`   ${r.platform.padEnd(20)} ${String(r.saved).padStart(4)} saved  (${r.duration}s)`)
}

if (empty.length) {
  console.log(`\n⚠️  Empty (${empty.length}):`)
  for (const r of empty) {
    console.log(`   ${r.platform.padEnd(20)} ${r.error || 'no data'}`)
  }
}

if (err.length) {
  console.log(`\n❌ Errors (${err.length}):`)
  for (const r of err) {
    console.log(`   ${r.platform.padEnd(20)} ${r.error}`)
  }
}

const totalSaved = results.reduce((s, r) => s + (r.saved || 0), 0)
console.log(`\nTotal: ${totalSaved} traders saved across ${ok.length} platforms`)

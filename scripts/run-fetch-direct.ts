import 'dotenv/config'
import { getInlineFetcher, getSupportedInlinePlatforms } from '../lib/cron/fetchers'
import { createSupabaseAdmin } from '../lib/cron/utils'

const platforms = process.argv.slice(2)
const allPlatforms = getSupportedInlinePlatforms()

if (platforms.length === 0 || platforms[0] === 'all') {
  console.log('Supported platforms:', allPlatforms.join(', '))
  console.log('Running all...')
  runAll(allPlatforms)
} else {
  runAll(platforms)
}

async function runAll(platformList: string[]) {
  const supabase = createSupabaseAdmin()
  if (!supabase) {
    console.error('Failed to create Supabase client')
    process.exit(1)
  }

  const results: Record<string, any> = {}

  for (const p of platformList) {
    const fetcher = getInlineFetcher(p)
    if (!fetcher) {
      console.log(`[${p}] No fetcher found, skipping`)
      continue
    }

    console.log(`\n=== ${p} ===`)
    const start = Date.now()
    try {
      const result = await fetcher(supabase, ['7D', '30D', '90D'])
      const dur = Date.now() - start
      const saved = Object.values(result.periods).reduce((sum: number, p: any) => sum + (p.saved || 0), 0)
      const total = Object.values(result.periods).reduce((sum: number, p: any) => sum + (p.total || 0), 0)
      const errors = Object.entries(result.periods)
        .filter(([_, p]: [string, any]) => p.error)
        .map(([k, p]: [string, any]) => `${k}: ${p.error.substring(0, 60)}`)

      console.log(`  total=${total} saved=${saved} dur=${dur}ms`)
      if (errors.length > 0) console.log(`  errors: ${errors.join('; ')}`)
      results[p] = { total, saved, dur, errors }
    } catch (e: any) {
      console.log(`  ERROR: ${e.message}`)
      results[p] = { error: e.message }
    }
  }

  console.log('\n\n=== SUMMARY ===')
  for (const [p, r] of Object.entries(results)) {
    if (r.error) {
      console.log(`${p}: ERROR - ${r.error}`)
    } else {
      console.log(`${p}: total=${r.total} saved=${r.saved} dur=${r.dur}ms${r.errors?.length ? ' ERRORS: ' + r.errors.join('; ') : ''}`)
    }
  }
}

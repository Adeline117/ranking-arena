import 'dotenv/config'
import { getInlineFetcher, getSupportedInlinePlatforms } from '../lib/cron/fetchers'
import { createSupabaseAdmin } from '../lib/cron/utils'

const TIMEOUT_MS = 120_000 // 2 min per platform
const CONCURRENCY = 3

const supabase = createSupabaseAdmin()
if (!supabase) { console.error('No supabase'); process.exit(1) }

const platforms = process.argv.slice(2).length > 0 
  ? process.argv.slice(2) 
  : getSupportedInlinePlatforms()

console.log(`Running ${platforms.length} platforms, concurrency=${CONCURRENCY}, timeout=${TIMEOUT_MS}ms`)

async function fetchPlatform(p: string): Promise<string> {
  const fetcher = getInlineFetcher(p)
  if (!fetcher) return `${p}: NO_FETCHER`
  
  const start = Date.now()
  try {
    const result = await Promise.race([
      fetcher(supabase!, ['7D', '30D', '90D']),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS))
    ])
    const dur = Date.now() - start
    const saved = Object.values(result.periods).reduce((sum: number, p: any) => sum + (p.saved || 0), 0)
    const total = Object.values(result.periods).reduce((sum: number, p: any) => sum + (p.total || 0), 0)
    const errors = Object.entries(result.periods)
      .filter(([_, p]: [string, any]) => p.error)
      .map(([k, p]: [string, any]) => `${k}:${(p.error as string).substring(0, 50)}`)
    const line = `${p}: total=${total} saved=${saved} dur=${dur}ms${errors.length ? ' ERR:' + errors.join(';') : ''}`
    console.log(line)
    return line
  } catch (e: any) {
    const dur = Date.now() - start
    const line = `${p}: ERROR ${e.message} dur=${dur}ms`
    console.log(line)
    return line
  }
}

async function main() {
  const results: string[] = []
  
  for (let i = 0; i < platforms.length; i += CONCURRENCY) {
    const batch = platforms.slice(i, i + CONCURRENCY)
    console.log(`\n--- Batch: ${batch.join(', ')} ---`)
    const batchResults = await Promise.allSettled(batch.map(fetchPlatform))
    for (const r of batchResults) {
      results.push(r.status === 'fulfilled' ? r.value : `ERROR: ${r.reason}`)
    }
  }
  
  console.log('\n\n=== FINAL SUMMARY ===')
  results.forEach(r => console.log(r))
  process.exit(0)
}

main()

// Worker process - fetches a single platform and exits
import 'dotenv/config'
import { getInlineFetcher } from '../lib/cron/fetchers'
import { createSupabaseAdmin } from '../lib/cron/utils'

const platform = process.argv[2]
if (!platform) { console.error('Usage: tsx fetch-worker.ts PLATFORM'); process.exit(1) }

const supabase = createSupabaseAdmin()
if (!supabase) { console.error('No supabase'); process.exit(1) }

const fetcher = getInlineFetcher(platform)
if (!fetcher) { console.log(JSON.stringify({ platform, error: 'NO_FETCHER' })); process.exit(0) }

const start = Date.now()
fetcher(supabase, ['7D', '30D', '90D']).then(result => {
  const dur = Date.now() - start
  const saved = Object.values(result.periods).reduce((s: number, p: any) => s + (p.saved || 0), 0)
  const total = Object.values(result.periods).reduce((s: number, p: any) => s + (p.total || 0), 0)
  const errors = Object.entries(result.periods)
    .filter(([_, p]: [string, any]) => p.error)
    .map(([k, p]: [string, any]) => `${k}:${(p.error as string).substring(0, 50)}`)
  console.log(JSON.stringify({ platform, total, saved, dur, errors }))
  process.exit(0)
}).catch(e => {
  console.log(JSON.stringify({ platform, error: e.message, dur: Date.now() - start }))
  process.exit(1)
})

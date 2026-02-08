import 'dotenv/config'
import { getInlineFetcher } from '../lib/cron/fetchers'
import { createSupabaseAdmin } from '../lib/cron/utils'

// Force exit after 2 min
setTimeout(() => { console.log('FORCED EXIT'); process.exit(1) }, 120_000)

const supabase = createSupabaseAdmin()!
const fetcher = getInlineFetcher('xt')!

console.log('Starting XT fetch...')
console.time('xt')

fetcher(supabase, ['7D']).then(result => {
  console.timeEnd('xt')
  const p = result.periods['7D']
  console.log(`total=${p?.total || 0} saved=${p?.saved || 0} err=${p?.error || 'none'}`)
  process.exit(0)
}).catch(e => {
  console.timeEnd('xt')
  console.log(`ERROR: ${e.message}`)
  process.exit(1)
})

import 'dotenv/config'
import { getInlineFetcher } from '../lib/cron/fetchers'
import { createSupabaseAdmin } from '../lib/cron/utils'

// Force exit after 30 min
setTimeout(() => { 
  console.log('\nFORCED EXIT after 30min')
  process.exit(0) 
}, 1800_000)

const supabase = createSupabaseAdmin()!
const platforms = ['xt', 'bitget_futures', 'bitget_spot', 'okx_web3', 'gmx', 'gains', 'jupiter_perps', 'hyperliquid', 'dydx', 'okx_futures']

;(async () => {
  for (const p of platforms) {
    const fetcher = getInlineFetcher(p)
    if (!fetcher) { console.log(`${p}: NO_FETCHER`); continue }
    
    const start = Date.now()
    // Use only 7D period for speed; full periods for enrichment-heavy
    const periods = ['hyperliquid', 'dydx', 'okx_futures'].includes(p) ? ['7D', '30D', '90D'] : ['7D', '30D', '90D']
    
    process.stderr.write(`[${p}] starting...\n`)
    
    try {
      const result = await fetcher(supabase, periods)
      const dur = Math.round((Date.now() - start) / 1000)
      const saved = Object.values(result.periods).reduce((s: number, v: any) => s + (v.saved || 0), 0)
      const total = Object.values(result.periods).reduce((s: number, v: any) => s + (v.total || 0), 0)
      const errs = Object.entries(result.periods)
        .filter(([_, v]: [string, any]) => v.error)
        .map(([k, v]: [string, any]) => `${k}:${(v.error as string).substring(0, 40)}`)
      console.log(`${p}: total=${total} saved=${saved} dur=${dur}s${errs.length ? ' ERR:' + errs.join(';') : ' OK'}`)
    } catch (e: any) {
      console.log(`${p}: ERROR ${e.message} dur=${Math.round((Date.now() - start)/1000)}s`)
    }
  }
  
  console.log('DONE')
  process.exit(0)
})()

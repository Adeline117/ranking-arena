import 'dotenv/config'
import { getInlineFetcher } from '../lib/cron/fetchers'
import { createSupabaseAdmin } from '../lib/cron/utils'

const TIMEOUT_MS = 90_000

const supabase = createSupabaseAdmin()
if (!supabase) { console.error('No supabase'); process.exit(1) }

// Skip geo-blocked and known-broken platforms
const platforms = [
  'htx', 'htx_futures',  // worked
  'okx_web3',
  'bitget_futures', 'bitget_spot',
  'xt', 'pionex', 'bingx', 'gateio', 'mexc',
  'kucoin', 'coinex', 'phemex', 'weex',
  'lbank', 'blofin',
  'gmx', 'kwenta', 'mux', 'gains', 'vertex', 'drift',
  'jupiter_perps', 'aevo', 'synthetix',
  // enrichment-heavy (run last with longer timeout)
  'hyperliquid', 'dydx', 'okx_futures',
]

const results: string[] = []

async function run() {
  for (const p of platforms) {
    const fetcher = getInlineFetcher(p)
    if (!fetcher) { console.log(`${p}: NO_FETCHER`); continue }
    
    const timeout = ['hyperliquid', 'dydx', 'okx_futures'].includes(p) ? 600_000 : TIMEOUT_MS
    console.log(`\n[${p}] starting... (timeout ${timeout/1000}s)`)
    const start = Date.now()
    
    try {
      const result = await Promise.race([
        fetcher(supabase!, ['7D', '30D', '90D']),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), timeout))
      ])
      const dur = Date.now() - start
      const saved = Object.values(result.periods).reduce((s: number, p: any) => s + (p.saved || 0), 0)
      const total = Object.values(result.periods).reduce((s: number, p: any) => s + (p.total || 0), 0)
      const errs = Object.entries(result.periods)
        .filter(([_, p]: [string, any]) => p.error)
        .map(([k, p]: [string, any]) => `${k}:${(p.error as string).substring(0, 40)}`)
      const line = `${p}: total=${total} saved=${saved} dur=${Math.round(dur/1000)}s${errs.length ? ' ERR:' + errs.join(';') : ' OK'}`
      console.log(line)
      results.push(line)
    } catch (e: any) {
      const dur = Date.now() - start
      const line = `${p}: ${e.message} dur=${Math.round(dur/1000)}s`
      console.log(line)
      results.push(line)
    }
  }

  console.log('\n\n=== SUMMARY ===')
  let totalSaved = 0
  results.forEach(r => {
    console.log(r)
    const m = r.match(/saved=(\d+)/)
    if (m) totalSaved += parseInt(m[1])
  })
  console.log(`\nTotal saved across all platforms: ${totalSaved}`)
  process.exit(0)
}

run()

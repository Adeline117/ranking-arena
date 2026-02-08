import 'dotenv/config'
import { getInlineFetcher } from '../lib/cron/fetchers'
import { createSupabaseAdmin } from '../lib/cron/utils'

const TIMEOUT_MS = 120_000
const supabase = createSupabaseAdmin()!

// Order: fast platforms first, slow/enrichment-heavy last
const platforms = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [
  'htx', 'lbank', 'blofin', 'aevo', 'synthetix',
  'kwenta', 'mux', 'vertex', 'drift', 'phemex', 'weex',
  'bingx', 'coinex', 'kucoin', 'pionex', 'gateio', 'mexc',
  'xt', 'bitget_futures', 'bitget_spot', 'okx_web3',
  'gmx', 'gains', 'jupiter_perps',
  'hyperliquid', 'dydx', 'okx_futures',
]

const results: Array<{p: string, total: number, saved: number, dur: number, err: string}> = []

;(async () => {
  // Force Node.js to exit after 2 hours no matter what
  setTimeout(() => { console.log('\n\nFORCED EXIT after 2h'); printSummary(); process.exit(0) }, 7200_000)

  for (const p of platforms) {
    const fetcher = getInlineFetcher(p)
    if (!fetcher) { console.log(`${p}: NO_FETCHER`); continue }

    const isEnrichHeavy = ['hyperliquid', 'dydx', 'okx_futures'].includes(p)
    const tm = isEnrichHeavy ? 600_000 : TIMEOUT_MS
    
    process.stdout.write(`${p}: `)
    const start = Date.now()

    try {
      const result = await Promise.race([
        fetcher(supabase, ['7D', '30D', '90D']),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), tm))
      ])
      const dur = Date.now() - start
      const saved = Object.values(result.periods).reduce((s: number, v: any) => s + (v.saved || 0), 0)
      const total = Object.values(result.periods).reduce((s: number, v: any) => s + (v.total || 0), 0)
      const errs = Object.entries(result.periods)
        .filter(([_, v]: [string, any]) => v.error)
        .map(([k, v]: [string, any]) => `${k}:${(v.error as string).substring(0, 40)}`)
      const errStr = errs.join(';')
      console.log(`total=${total} saved=${saved} dur=${Math.round(dur/1000)}s${errStr ? ' ERR:' + errStr : ' OK'}`)
      results.push({p, total, saved, dur, err: errStr})
    } catch (e: any) {
      const dur = Date.now() - start
      console.log(`${e.message} dur=${Math.round(dur/1000)}s`)
      results.push({p, total: 0, saved: 0, dur, err: e.message})
    }
  }

  printSummary()
  process.exit(0)
})()

function printSummary() {
  console.log('\n=== SUMMARY ===')
  let totalSaved = 0
  for (const r of results) {
    console.log(`${r.p}: saved=${r.saved} total=${r.total} dur=${Math.round(r.dur/1000)}s${r.err ? ' ERR' : ' OK'}`)
    totalSaved += r.saved
  }
  console.log(`\nTotal snapshots saved: ${totalSaved}`)
}

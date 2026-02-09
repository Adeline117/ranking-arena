/**
 * dYdX v4 trades_count backfill
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { data: rows } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'dydx')
    .or('trades_count.is.null,trades_count.eq.0')
  
  const traders = [...new Set(rows?.map(r => r.source_trader_id) || [])]
  console.log(`dYdX traders: ${traders.length}`)
  
  let updated = 0
  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i]
    try {
      const res = await fetch(`https://indexer.dydx.trade/v4/fills?address=${addr}&subaccountNumber=0&limit=100`, { signal: AbortSignal.timeout(10000) })
      if (res.ok) {
        const data = await res.json()
        if (data.fills?.length > 0) {
          await supabase.from('trader_snapshots').update({ trades_count: data.fills.length })
            .eq('source', 'dydx').eq('source_trader_id', addr)
            .or('trades_count.is.null,trades_count.eq.0')
          updated++
        }
      }
      await sleep(200)
    } catch {}
  }
  console.log(`✅ dYdX: ${updated} updated`)
}

main().catch(e => { console.error(e); process.exit(1) })

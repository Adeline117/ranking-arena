/**
 * Hyperliquid trades_count backfill - lightweight version
 * Processes BATCH_SIZE traders then exits. Run in a loop.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const BATCH = parseInt(process.argv[2] || '100')
const OFFSET = parseInt(process.argv[3] || '0')

async function main() {
  // Get batch of traders
  const { data: rows } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'hyperliquid')
    .or('trades_count.is.null,trades_count.eq.0')
    .order('source_trader_id')
    .range(0, BATCH - 1)
  
  if (!rows?.length) {
    console.log('NO_MORE')
    return
  }
  
  const traders = [...new Set(rows.map(r => r.source_trader_id))]
  console.log(`Processing ${traders.length} traders`)
  
  let updated = 0
  for (const addr of traders) {
    try {
      let totalFills = 0, startTime = 0, pages = 0
      
      while (pages < 50) {
        const res = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFillsByTime', user: addr, startTime, aggregateByTime: true }),
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) break
        const data = await res.json()
        if (!Array.isArray(data) || data.length === 0) break
        totalFills += data.length
        pages++
        if (data.length < 2000) break
        startTime = data[data.length - 1].time + 1
        await sleep(200)
      }
      
      if (totalFills > 0) {
        await supabase
          .from('trader_snapshots')
          .update({ trades_count: totalFills })
          .eq('source', 'hyperliquid')
          .eq('source_trader_id', addr)
          .or('trades_count.is.null,trades_count.eq.0')
        updated++
      } else {
        // Mark as 0 so we skip next time (set to -1 as marker, or just set 0)
        // Actually, leave null traders with 0 fills as-is to distinguish
        // Set trades_count = 0 to mark as "checked, no trades"
        await supabase
          .from('trader_snapshots')
          .update({ trades_count: 0 })
          .eq('source', 'hyperliquid')
          .eq('source_trader_id', addr)
          .is('trades_count', null)
      }
      
      await sleep(150)
    } catch (e) {
      // skip
    }
  }
  
  console.log(`DONE updated=${updated}/${traders.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })

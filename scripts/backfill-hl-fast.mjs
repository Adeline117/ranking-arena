/**
 * Hyperliquid trades_count backfill - fast version
 * Only gets first page (max 2000 fills). If 2000, marks as 2000+ 
 * Uses concurrent requests for speed
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getFills(addr) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: addr }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return -1
  const data = await res.json()
  return Array.isArray(data) ? data.length : 0
}

async function main() {
  // Get ALL traders needing backfill
  const all = []
  let from = 0
  while (true) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', 'hyperliquid')
      .is('trades_count', null)
      .order('source_trader_id')
      .range(from, from + 999)
    if (!data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  
  const traders = [...new Set(all.map(r => r.source_trader_id))]
  console.log(`Hyperliquid traders: ${traders.length}`)
  
  let updated = 0, checked = 0
  const CONCURRENCY = 5
  
  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async addr => {
      try {
        const count = await getFills(addr)
        return { addr, count }
      } catch {
        return { addr, count: -1 }
      }
    }))
    
    for (const { addr, count } of results) {
      if (count >= 0) {
        await supabase.from('trader_snapshots').update({ trades_count: count })
          .eq('source', 'hyperliquid').eq('source_trader_id', addr).is('trades_count', null)
        if (count > 0) updated++
        checked++
      }
    }
    
    if ((checked) % 100 < CONCURRENCY || i + CONCURRENCY >= traders.length)
      console.log(`  [${checked}/${traders.length}] updated=${updated}`)
    
    await sleep(200) // 5 concurrent, 200ms gap = ~25 req/s
  }
  
  console.log(`✅ Hyperliquid: ${updated} updated out of ${checked} checked`)
}

main().catch(e => { console.error(e); process.exit(1) })

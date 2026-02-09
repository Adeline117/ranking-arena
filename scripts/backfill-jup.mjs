/**
 * Jupiter Perps trades_count backfill
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  // Build address mapping from Jupiter API
  console.log('Fetching address mapping...')
  const addressMap = new Map()
  const MARKETS = [
    'So11111111111111111111111111111111111111112',
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ]
  
  for (const year of [2025, 2026]) {
    for (const mint of MARKETS) {
      for (const sortBy of ['pnl', 'volume']) {
        try {
          const res = await fetch(`https://perps-api.jup.ag/v1/top-traders?marketMint=${mint}&sortBy=${sortBy}&limit=1000&year=${year}&week=current`, { signal: AbortSignal.timeout(10000) })
          if (res.ok) {
            const data = await res.json()
            for (const key of ['topTradersByPnl', 'topTradersByVolume']) {
              if (data[key]) for (const t of data[key]) if (t.owner) addressMap.set(t.owner.toLowerCase(), t.owner)
            }
          }
        } catch {}
        await sleep(300)
      }
    }
  }
  console.log(`Address map: ${addressMap.size} entries`)
  
  // Get traders needing backfill
  const { data: rows } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'jupiter_perps')
    .or('trades_count.is.null,trades_count.eq.0')
  
  const traders = [...new Set(rows?.map(r => r.source_trader_id) || [])]
  console.log(`Traders: ${traders.length}`)
  
  let updated = 0, noMapping = 0
  for (let i = 0; i < traders.length; i++) {
    const dbAddr = traders[i]
    const original = addressMap.get(dbAddr.toLowerCase()) || addressMap.get(dbAddr)
    if (!original) { noMapping++; continue }
    
    try {
      const res = await fetch(`https://perps-api.jup.ag/v1/trades?walletAddress=${original}&limit=100`, { signal: AbortSignal.timeout(10000) })
      if (res.ok) {
        const data = await res.json()
        if (data.count > 0 || data.dataList?.length > 0) {
          const count = data.count || data.dataList.length
          const updates = { trades_count: count }
          // Win rate from closing trades
          if (data.dataList) {
            const closing = data.dataList.filter(t => t.pnl != null && t.action !== 'Increase')
            if (closing.length > 0) {
              const wins = closing.filter(t => parseFloat(t.pnl || '0') > 0).length
              updates.win_rate = parseFloat(((wins / closing.length) * 100).toFixed(2))
            }
          }
          await supabase.from('trader_snapshots').update(updates)
            .eq('source', 'jupiter_perps').eq('source_trader_id', dbAddr)
            .or('trades_count.is.null,trades_count.eq.0')
          updated++
        }
      }
      await sleep(400)
    } catch {}
    if ((i+1) % 50 === 0) console.log(`  [${i+1}/${traders.length}] updated=${updated} noMapping=${noMapping}`)
  }
  console.log(`✅ Jupiter: ${updated} updated, ${noMapping} no mapping`)
}

main().catch(e => { console.error(e); process.exit(1) })

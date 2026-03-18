import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  // Get hyperliquid traders with null win_rate
  const { data: traders } = await supabase.from('trader_snapshots_v2')
    .select('trader_key').eq('platform', 'hyperliquid').is('win_rate', null).limit(500)
  const keys = [...new Set(traders?.map(t => t.trader_key) || [])]
  console.log(`${keys.length} hyperliquid traders need win_rate`)

  let filled = 0
  for (let i = 0; i < keys.length; i += 5) {
    const batch = keys.slice(i, i + 5)
    await Promise.all(batch.map(async (addr) => {
      try {
        // Fetch fills from Hyperliquid API
        const resp = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFills', user: addr }),
          signal: AbortSignal.timeout(10000),
        })
        if (!resp.ok) return
        const fills = await resp.json()
        if (!Array.isArray(fills) || fills.length < 3) return
        
        // Group fills by trade (closedPnl != 0 means a closing fill)
        const closingFills = fills.filter(f => f.closedPnl && parseFloat(f.closedPnl) !== 0)
        if (closingFills.length < 3) return
        
        const wins = closingFills.filter(f => parseFloat(f.closedPnl) > 0).length
        const wr = Math.round((wins / closingFills.length) * 1000) / 10
        
        // Also compute MDD from cumulative PnL
        let cumPnl = 0, peakPnl = 0, maxDD = 0
        for (const f of closingFills.sort((a, b) => a.time - b.time)) {
          cumPnl += parseFloat(f.closedPnl)
          if (cumPnl > peakPnl) peakPnl = cumPnl
          if (peakPnl > 0) {
            const dd = ((peakPnl - cumPnl) / peakPnl) * 100
            if (dd > maxDD) maxDD = dd
          }
        }
        
        const updates = { win_rate: wr }
        if (maxDD > 0 && maxDD <= 100) updates.max_drawdown = Math.round(maxDD * 100) / 100
        
        await supabase.from('trader_snapshots_v2').update(updates)
          .eq('platform', 'hyperliquid').eq('trader_key', addr).is('win_rate', null)
        await supabase.from('trader_snapshots').update(updates)
          .eq('source', 'hyperliquid').eq('source_trader_id', addr).is('win_rate', null)
        filled++
      } catch { /* skip */ }
    }))
    if ((i + 5) % 50 === 0) console.log(`  ${filled} filled (${i+5}/${keys.length})`)
    await new Promise(r => setTimeout(r, 200)) // rate limit
  }
  console.log(`\nHyperliquid: ${filled}/${keys.length} filled with win_rate + MDD`)
}
main().catch(console.error)

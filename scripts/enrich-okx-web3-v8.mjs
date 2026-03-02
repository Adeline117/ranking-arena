import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
const CHAINS = [501, 1, 56, 137, 42161, 10, 8453, 43114]
const PERIODS = [1, 2, 3, 4, 5]
const sleep = ms => new Promise(r => setTimeout(r, ms))
function truncate(addr){ if(!addr||addr.length<11) return addr; return addr.slice(0,6)+'...'+addr.slice(-4) }

const {data:rows} = await sb.from('trader_snapshots').select('id,source_trader_id').eq('source','okx_web3').is('win_rate',null)
const needWR = new Map(); rows?.forEach(r => needWR.set(r.source_trader_id, r.id))
console.log('Need WR:', needWR.size)

let updated = 0
for (const chainId of CHAINS) {
  if (needWR.size === 0) break
  console.log(`\nChain ${chainId} remaining: ${needWR.size}`)
  for (const pt of PERIODS) {
    let start = 0, emptyRuns = 0
    while (emptyRuns < 3 && start < 20000) { // expanded to 20K
      const params = new URLSearchParams({ rankStart: start, rankEnd: start+100, periodType: pt, rankBy:1, label:'all', desc:'true', chainId, t: Date.now() })
      try {
        const res = await fetch(`${BASE}?${params}`, { headers: {'User-Agent':'Mozilla/5.0','Referer':'https://web3.okx.com/zh-hans/copy-trade'}, signal: AbortSignal.timeout(15000) })
        const d = res.ok ? await res.json() : null
        const items = d?.data?.rankingInfos || []
        if (!items.length) { emptyRuns++; await sleep(300); continue }
        emptyRuns = 0
        for (const t of items) {
          const tr = truncate(t.walletAddress)
          if (needWR.has(tr)) {
            const wr = t.winRate != null ? parseFloat(t.winRate) : null
            if (wr != null && wr >= 0 && wr <= 100) {
              await sb.from('trader_snapshots').update({ win_rate: wr }).eq('id', needWR.get(tr))
              needWR.delete(tr); updated++
              console.log(`  ✅ ${tr} WR=${wr}%`)
            }
          }
        }
      } catch {}
      start += 100; await sleep(200)
    }
  }
}
console.log(`\nDone: updated=${updated} remaining=${needWR.size}`)

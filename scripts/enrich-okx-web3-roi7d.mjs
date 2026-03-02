import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
const CHAINS = [501, 1, 56, 137, 42161, 10, 8453]
const sleep = ms => new Promise(r => setTimeout(r, ms))
function truncate(a){ if(!a||a.length<11) return a; return a.slice(0,6)+'...'+a.slice(-4) }

// 找 roi_7d 或 roi_30d 为 null 的 okx_web3
const {data:rows7} = await sb.from('trader_snapshots').select('id,source_trader_id').eq('source','okx_web3').is('roi_7d',null)
const {data:rows30} = await sb.from('trader_snapshots').select('id,source_trader_id').eq('source','okx_web3').is('roi_30d',null)
const need7 = new Map(); rows7?.forEach(r => need7.set(r.source_trader_id, r.id))
const need30 = new Map(); rows30?.forEach(r => need30.set(r.source_trader_id, r.id))
console.log(`roi_7d null: ${need7.size}, roi_30d null: ${need30.size}`)

// periodType=1→7D roi_7d, periodType=2→30D roi_30d
const configs = [{pt:1, map:need7, field:'roi_7d'}, {pt:2, map:need30, field:'roi_30d'}]
let updated = 0

for (const {pt, map, field} of configs) {
  if (map.size === 0) continue
  for (const chainId of CHAINS) {
    if (map.size === 0) break
    let start = 0, empty = 0
    while (empty < 3 && start < 10000) {
      const params = new URLSearchParams({rankStart:start, rankEnd:start+100, periodType:pt, rankBy:1, label:'all', desc:'true', chainId, t:Date.now()})
      try {
        const res = await fetch(`${BASE}?${params}`, {headers:{'User-Agent':'Mozilla/5.0','Referer':'https://web3.okx.com/zh-hans/copy-trade'}, signal:AbortSignal.timeout(15000)})
        const d = res.ok ? await res.json() : null
        const items = d?.data?.rankingInfos || []
        if (!items.length) { empty++; await sleep(200); continue }
        empty = 0
        for (const t of items) {
          const tr = truncate(t.walletAddress)
          if (map.has(tr)) {
            const roi = t.roi != null ? parseFloat(t.roi) : null
            if (roi != null) {
              await sb.from('trader_snapshots').update({[field]: roi}).eq('id', map.get(tr))
              map.delete(tr); updated++
            }
          }
        }
      } catch {}
      start += 100; await sleep(150)
    }
  }
}
console.log(`Done: ${field} updated=${updated}`)

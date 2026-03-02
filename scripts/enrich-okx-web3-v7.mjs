import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
const CHAINS = [501,1,56,137,42161,10,43114,8453,728,100,250,1313161554,59144,5000,5001] // expanded
const PERIODS = [1,2,3,4]
function truncate(addr){ if(!addr||addr.length<11) return addr; return addr.slice(0,6)+'...'+addr.slice(-4) }
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function fetchPage(chainId,periodType,rankStart,rankEnd){try{const r=await fetch(BASE+'?'+new URLSearchParams({rankStart,rankEnd,periodType,rankBy:1,label:'all',desc:'true',chainId,t:Date.now()}),{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://web3.okx.com/zh-hans/copy-trade'},signal:AbortSignal.timeout(20000)});return r.ok?await r.json():null}catch{return null}}
const {data:rows}=await sb.from('trader_snapshots').select('id,source_trader_id').eq('source','okx_web3').is('win_rate',null)
const needWR=new Map(); rows?.forEach(r=>needWR.set(r.source_trader_id,r.id))
console.log('Need WR:',needWR.size)
let updated=0
for(const chainId of CHAINS){
  if(needWR.size===0) break
  console.log('Chain',chainId,'remaining:',needWR.size)
  for(const pt of PERIODS){
    let start=0, empty=0
    while(empty<2 && start<5000){
      const d=await fetchPage(chainId,pt,start,start+50)
      if(!d?.data?.rankingInfos?.length){empty++;await sleep(300);continue}
      empty=0
      for(const t of d.data.rankingInfos){
        const tr=truncate(t.walletAddress)
        if(needWR.has(tr)){
          const wr=t.winRate!=null?parseFloat(t.winRate):null
          if(wr!=null&&wr<=100){await sb.from('trader_snapshots').update({win_rate:wr}).eq('id',needWR.get(tr));needWR.delete(tr);updated++;console.log('  ✅',tr,'WR='+wr+'%')}
        }
      }
      start+=50;await sleep(200)
    }
  }
}
console.log('Done: updated='+updated+' remaining='+needWR.size)

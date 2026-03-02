#!/usr/bin/env node
/**
 * OKX Web3 WR Enrichment v6
 * FIXED: correct API params (periodType not pt, chainId required)
 * Covers 3 time periods x multiple chains
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const SOURCE = 'okx_web3'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
const CHAINS = [501, 1, 56, 137, 42161, 10, 43114, 8453] // SOL, ETH, BSC, POLYGON, ARB, OP, AVAX, BASE
const PERIODS = [1, 2, 3, 4] // 7D, 30D, 90D, 180D

const sleep = ms => new Promise(r => setTimeout(r, ms))

function truncate(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

async function fetchPage(chainId, periodType, rankStart, rankEnd) {
  const params = new URLSearchParams({ rankStart, rankEnd, periodType, rankBy: 1, label: 'all', desc: 'true', chainId, t: Date.now() })
  try {
    const res = await fetch(`${BASE}?${params}`, {
      headers: { 'User-Agent': UA, 'Referer': 'https://web3.okx.com/zh-hans/copy-trade' },
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

// Load all null WR okx_web3 traders
const { data: rows } = await sb.from('trader_snapshots').select('id,source_trader_id,win_rate').eq('source', SOURCE).is('win_rate', null)
console.log(`Found ${rows?.length} okx_web3 rows with null win_rate`)

const needWR = new Map()
rows?.forEach(r => needWR.set(r.source_trader_id, r.id))
console.log(`Unique truncated addresses: ${needWR.size}`)

let updated = 0, notFound = 0

for (const chainId of CHAINS) {
  console.log(`\n=== Chain ${chainId} ===`)
  for (const periodType of PERIODS) {
    let rankStart = 0, pageSize = 50, consecutive_empty = 0
    while (consecutive_empty < 3) {
      const d = await fetchPage(chainId, periodType, rankStart, rankStart + pageSize)
      if (!d?.data?.rankingInfos?.length) { consecutive_empty++; await sleep(500); break }
      consecutive_empty = 0
      let found = 0
      for (const trader of d.data.rankingInfos) {
        const addr = trader.walletAddress || ''
        const truncated = truncate(addr)
        if (needWR.has(truncated)) {
          const wr = trader.winRate != null ? parseFloat(trader.winRate) : null
          const mdd = trader.maxDrawdown != null ? Math.abs(parseFloat(trader.maxDrawdown)) * 100 : null
          if (wr != null) {
            await sb.from('trader_snapshots').update({ win_rate: wr, max_drawdown: mdd }).eq('id', needWR.get(truncated))
            console.log(`  ✅ ${truncated} → WR=${wr.toFixed(1)}%`)
            needWR.delete(truncated)
            updated++
            found++
          }
        }
      }
      rankStart += pageSize
      if (rankStart > 10000) break // safety limit
      await sleep(300)
    }
  }
  if (needWR.size === 0) break
}

console.log(`\n=== Done: updated=${updated}, remaining=${needWR.size} ===`)

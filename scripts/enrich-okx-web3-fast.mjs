#!/usr/bin/env node
/**
 * Fast OKX Web3 enrichment — concurrent chain fetching
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'

async function fetchJSON(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < retries - 1) await sleep(500) }
  }
  return null
}

function truncAddr(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function computeMDD(pnlHistory) {
  if (!pnlHistory?.length || pnlHistory.length < 2) return null
  const values = pnlHistory.map(h => parseFloat(h.pnl)).filter(v => !isNaN(v))
  if (values.length < 2) return null
  let peak = values[0], maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) { const dd = ((peak - v) / peak) * 100; if (dd > maxDD) maxDD = dd }
  }
  return maxDD > 0 && maxDD <= 100 ? maxDD : null
}

async function fetchChain(chainId, periodType, label) {
  const traders = new Map()
  for (let start = 0; start < 2000; start += 20) {
    const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=1&label=all&desc=true&rankEnd=${start + 20}&chainId=${chainId}`
    const json = await fetchJSON(url)
    const infos = json?.data?.rankingInfos || []
    if (infos.length === 0) break
    for (const t of infos) {
      const addr = t.walletAddress
      if (!addr) continue
      traders.set(addr, {
        truncated: truncAddr(addr),
        winRate: parseFloat(t.winRate) || null,
        mdd: computeMDD(t.pnlHistory),
        txCount: parseInt(t.txCount) || null,
      })
    }
    if (traders.size > 0 && traders.size % 500 === 0) process.stdout.write('.')
    await sleep(80)
  }
  console.log(`    ${label} chain ${chainId}: ${traders.size} traders`)
  return traders
}

async function getAllSnapshots() {
  const all = []
  let offset = 0
  while (true) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'okx_web3')
      .range(offset, offset + 999)
    if (!data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  return all
}

async function main() {
  console.log('OKX Web3 Fast Enrichment')
  
  const snaps = await getAllSnapshots()
  console.log(`DB: ${snaps.length} snapshots`)
  
  // Build lookup
  const byTrader = new Map()
  for (const s of snaps) {
    const arr = byTrader.get(s.source_trader_id) || []
    arr.push(s)
    byTrader.set(s.source_trader_id, arr)
  }
  
  const PERIOD_MAP = { '30D': '2', '90D': '3' } // 7D already done
  const CHAINS = [501, 1, 56, 8453]
  
  let totalUpdated = 0
  
  for (const [period, periodType] of Object.entries(PERIOD_MAP)) {
    console.log(`\n--- ${period} ---`)
    
    // Fetch all chains concurrently (2 at a time to avoid rate limits)
    const allTraders = new Map()
    
    for (let i = 0; i < CHAINS.length; i += 2) {
      const batch = CHAINS.slice(i, i + 2)
      const results = await Promise.all(batch.map(c => fetchChain(c, periodType, period)))
      for (const chainTraders of results) {
        for (const [addr, data] of chainTraders) {
          allTraders.set(addr, data)
          allTraders.set(data.truncated, data)
        }
      }
    }
    
    console.log(`  Total unique: ${[...new Set([...allTraders.values()])].length}`)
    
    // Match and update
    let matched = 0, updated = 0
    for (const [traderId, traderSnaps] of byTrader) {
      const periodSnaps = traderSnaps.filter(s => s.season_id === period)
      if (!periodSnaps.length) continue
      
      const apiInfo = allTraders.get(traderId)
      if (!apiInfo) continue
      matched++
      
      for (const snap of periodSnaps) {
        const updates = {}
        if (snap.win_rate == null && apiInfo.winRate != null) updates.win_rate = apiInfo.winRate
        if (snap.max_drawdown == null && apiInfo.mdd != null) updates.max_drawdown = apiInfo.mdd
        if (snap.trades_count == null && apiInfo.txCount != null) updates.trades_count = apiInfo.txCount
        
        if (Object.keys(updates).length) {
          const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
          if (!error) updated++
        }
      }
    }
    
    console.log(`  Matched: ${matched}, Updated: ${updated}`)
    totalUpdated += updated
  }
  
  // After stats
  console.log('\n📊 AFTER:')
  const after = await getAllSnapshots()
  for (const period of ['7D', '30D', '90D']) {
    const s = after.filter(r => r.season_id === period)
    console.log(`  ${period} (${s.length}): no_wr=${s.filter(r=>r.win_rate==null).length}, no_tc=${s.filter(r=>r.trades_count==null).length}, no_mdd=${s.filter(r=>r.max_drawdown==null).length}`)
  }
  
  console.log(`\n✅ Total updated: ${totalUpdated}`)
}

main().catch(console.error)

#!/usr/bin/env node
/**
 * Enrichment script for OKX (futures + web3) and HTX futures gaps
 * 
 * OKX Futures: paginate list API for winRatio/aum, position history for trades_count/win_rate, weekly PnL for MDD
 * HTX Futures: paginate rank API for mdd/aum (trades_count unavailable from API)
 * OKX Web3: paginate ranking API for winRate/MDD across multiple chains
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchJSON(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < retries - 1) await sleep(1000) }
  }
  return null
}

// ============================================
// Helper: get all snapshots for a source
// ============================================
async function getAllSnapshots(source) {
  const all = []
  let offset = 0
  while (true) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count, pnl, roi')
      .eq('source', source)
      .range(offset, offset + 999)
    if (!data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  return all
}

// ============================================
// OKX FUTURES
// ============================================
async function enrichOkxFutures() {
  console.log('\n🟢 OKX Futures Enrichment')
  
  const snaps = await getAllSnapshots('okx_futures')
  console.log(`  DB: ${snaps.length} total snapshots`)
  
  // Build lookup: source_trader_id -> [snapshots]
  const byTrader = new Map()
  for (const s of snaps) {
    const arr = byTrader.get(s.source_trader_id) || []
    arr.push(s)
    byTrader.set(s.source_trader_id, arr)
  }
  
  const uniqueTraders = [...byTrader.keys()]
  console.log(`  Unique traders: ${uniqueTraders.length}`)
  
  // 1. Fetch list API for winRatio/aum (OKX limits to 20 per page, no real pagination)
  console.log('\n  Step 1: Fetching list API for winRatio/aum...')
  const listData = new Map()
  for (const sortType of ['pnl', 'winRatio', 'copiers']) {
    const url = `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&sortType=${sortType}&limit=20`
    const json = await fetchJSON(url)
    const ranks = json?.data?.[0]?.ranks || []
    for (const r of ranks) {
      if (r.uniqueCode && !listData.has(r.uniqueCode)) {
        listData.set(r.uniqueCode, {
          winRatio: parseFloat(r.winRatio) || null,
          aum: parseFloat(r.aum) || null,
          pnl: parseFloat(r.pnl) || null,
          pnlRatio: parseFloat(r.pnlRatio) || null,
          pnlRatios: r.pnlRatios || [],
        })
      }
    }
    await sleep(200)
  }
  // Also try fetching each trader individually from list with uniqueCode filter
  console.log(`    List API: ${listData.size} traders (limited by OKX pagination)`)
  console.log('    Will fetch per-trader data via stats/history APIs...')
  
  // 2. For traders missing MDD, calculate from weekly PnL or pnlRatios
  // 3. For traders missing trades_count, fetch position history
  console.log('\n  Step 2: Enriching individual traders...')
  
  let updatedCount = 0
  let processedCount = 0
  
  for (const [traderId, traderSnaps] of byTrader) {
    processedCount++
    
    // Check what's missing across all seasons
    const needsWR = traderSnaps.some(s => s.win_rate == null)
    const needsMDD = traderSnaps.some(s => s.max_drawdown == null)
    const needsTC = traderSnaps.some(s => s.trades_count == null)
    const needsPnl = traderSnaps.some(s => s.pnl == null)
    
    if (!needsWR && !needsMDD && !needsTC && !needsPnl) continue
    
    // Fetch per-trader data from list API with uniqueCode filter
    let listInfo = listData.get(traderId)
    if (!listInfo && (needsWR || needsPnl)) {
      const traderJson = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&uniqueCode=${traderId}`)
      const ranks = traderJson?.data?.[0]?.ranks || []
      if (ranks.length) {
        const r = ranks[0]
        listInfo = {
          winRatio: parseFloat(r.winRatio) || null,
          aum: parseFloat(r.aum) || null,
          pnl: parseFloat(r.pnl) || null,
          pnlRatio: parseFloat(r.pnlRatio) || null,
          pnlRatios: r.pnlRatios || [],
        }
        listData.set(traderId, listInfo)
      }
      await sleep(150)
    }
    
    // Calculate MDD from pnlRatios or weekly PnL
    let mdd = null
    if (needsMDD) {
      if (listInfo?.pnlRatios?.length >= 2) {
        const ratios = listInfo.pnlRatios.map(r => parseFloat(r.pnlRatio)).filter(v => !isNaN(v))
        if (ratios.length >= 2) {
          let peak = 1 + ratios[0]
          let maxDD = 0
          for (const r of ratios) {
            const equity = 1 + r
            if (equity > peak) peak = equity
            if (peak > 0) {
              const dd = ((peak - equity) / peak) * 100
              if (dd > maxDD) maxDD = dd
            }
          }
          if (maxDD > 0 && maxDD <= 100) mdd = maxDD
        }
      }
      
      if (mdd == null) {
        const weeklyPnl = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-weekly-pnl?instType=SWAP&uniqueCode=${traderId}`)
        const weeks = weeklyPnl?.data || []
        if (weeks.length >= 2) {
          let cumPnlRatio = 0
          let peak = 1
          let maxDD = 0
          for (const w of weeks) {
            cumPnlRatio += parseFloat(w.pnlRatio || 0)
            const equity = 1 + cumPnlRatio
            if (equity > peak) peak = equity
            if (peak > 0) {
              const dd = ((peak - equity) / peak) * 100
              if (dd > maxDD) maxDD = dd
            }
          }
          if (maxDD > 0 && maxDD <= 100) mdd = maxDD
        }
        await sleep(150)
      }
    }
    
    // Get trades_count and calculated win_rate from position history
    let tradesCount = null
    let calcWinRate = null
    if (needsTC || needsWR) {
      const posHistory = await fetchJSON(`https://www.okx.com/api/v5/copytrading/public-subpositions-history?instType=SWAP&uniqueCode=${traderId}&limit=100`)
      const trades = posHistory?.data || []
      if (trades.length > 0) {
        tradesCount = trades.length
        const wins = trades.filter(t => parseFloat(t.pnl || 0) > 0).length
        calcWinRate = (wins / trades.length) * 100
      }
      await sleep(150)
    }
    
    // Apply updates to all seasons for this trader
    for (const snap of traderSnaps) {
      const updates = {}
      
      if (snap.win_rate == null) {
        if (listInfo?.winRatio != null) updates.win_rate = listInfo.winRatio * 100
        else if (calcWinRate != null) updates.win_rate = calcWinRate
      }
      if (snap.max_drawdown == null && mdd != null) updates.max_drawdown = mdd
      if (snap.trades_count == null && tradesCount != null) updates.trades_count = tradesCount
      if (snap.pnl == null && listInfo?.pnl != null) updates.pnl = listInfo.pnl
      
      if (Object.keys(updates).length) {
        const { error } = await supabase
          .from('trader_snapshots')
          .update(updates)
          .eq('id', snap.id)
        if (!error) updatedCount++
      }
    }
    
    if (processedCount % 50 === 0) console.log(`    ${processedCount}/${uniqueTraders.length} processed, ${updatedCount} updated`)
    await sleep(100)
  }
  
  console.log(`  ✅ OKX Futures: ${updatedCount} snapshot rows updated`)
}

// ============================================
// HTX FUTURES
// ============================================
async function enrichHtxFutures() {
  console.log('\n🔴 HTX Futures Enrichment')
  
  const snaps = await getAllSnapshots('htx_futures')
  console.log(`  DB: ${snaps.length} total snapshots`)
  
  // Build lookup
  const byTrader = new Map()
  for (const s of snaps) {
    const arr = byTrader.get(s.source_trader_id) || []
    arr.push(s)
    byTrader.set(s.source_trader_id, arr)
  }
  
  // Fetch all HTX traders from rank API (multiple sort types)
  console.log('  Fetching HTX rank API...')
  const htxData = new Map()
  const PAGE_SIZE = 50
  
  for (const rankType of [1, 2, 3]) { // 1=pnl, 2=winRate, 3=copyProfit
    for (let page = 1; page <= 30; page++) {
      const json = await fetchJSON(`https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=${rankType}&pageNo=${page}&pageSize=${PAGE_SIZE}`)
      if (json?.code !== 200 || !json?.data?.itemList?.length) break
      const list = json.data.itemList
      
      for (const item of list) {
        const userSign = item.userSign || ''
        const uid = String(item.uid || '')
        const entry = {
          winRate: parseFloat(item.winRate) || null,
          aum: parseFloat(item.aum) || null,
          mdd: parseFloat(item.mdd) || null,
          pnl90: parseFloat(item.profit90) || null,
          profitRate90: parseFloat(item.profitRate90) || null,
          profitList: item.profitList || [],
          copyUserNum: parseInt(item.copyUserNum) || null,
        }
        
        // Calculate MDD from profitList if mdd field is 0 or not useful
        if (entry.profitList.length >= 2) {
          const equity = entry.profitList.map(r => 1 + parseFloat(r))
          let peak = equity[0], maxDD = 0
          for (const e of equity) {
            if (e > peak) peak = e
            if (peak > 0) {
              const dd = ((peak - e) / peak) * 100
              if (dd > maxDD) maxDD = dd
            }
          }
          if (maxDD > 0 && maxDD <= 100) entry.calculatedMDD = maxDD
        }
        
        if (userSign) htxData.set(userSign, entry)
        if (uid) htxData.set(uid, entry)
      }
      
      if (list.length < PAGE_SIZE) break
      await sleep(200)
    }
  }
  console.log(`  Fetched ${htxData.size} entries from rank API`)
  
  // HTX has no public trade-history endpoint, so trades_count stays null
  console.log('  Enriching traders (no trade-history API available for HTX)...')
  
  let updatedCount = 0
  for (const [traderId, traderSnaps] of byTrader) {
    const htxInfo = htxData.get(traderId)
    if (!htxInfo) continue
    
    for (const snap of traderSnaps) {
      const updates = {}
      
      if (snap.max_drawdown == null) {
        const mddVal = htxInfo.calculatedMDD || (htxInfo.mdd ? htxInfo.mdd * 100 : null)
        if (mddVal != null && mddVal > 0) updates.max_drawdown = mddVal
      }
      if (snap.pnl == null && htxInfo.pnl90 != null) updates.pnl = htxInfo.pnl90
      
      if (Object.keys(updates).length) {
        const { error } = await supabase
          .from('trader_snapshots')
          .update(updates)
          .eq('id', snap.id)
        if (!error) updatedCount++
      }
    }
  }
  
  console.log(`  ✅ HTX Futures: ${updatedCount} snapshot rows updated`)
}

// ============================================
// OKX WEB3
// ============================================
async function enrichOkxWeb3() {
  console.log('\n🌐 OKX Web3 Enrichment')
  
  const snaps = await getAllSnapshots('okx_web3')
  console.log(`  DB: ${snaps.length} total snapshots`)
  console.log(`  Missing: wr=${snaps.filter(s => s.win_rate == null).length}, tc=${snaps.filter(s => s.trades_count == null).length}, mdd=${snaps.filter(s => s.max_drawdown == null).length}`)
  
  // Build lookup by trader ID
  const byTrader = new Map()
  for (const s of snaps) {
    const arr = byTrader.get(s.source_trader_id) || []
    arr.push(s)
    byTrader.set(s.source_trader_id, arr)
  }
  
  const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'
  const PERIOD_MAP = { '7D': '1', '30D': '2', '90D': '3' }
  const CHAINS = [501, 1, 56, 8453] // SOL, ETH, BSC, BASE (top 4 chains)
  
  function truncateAddress(addr) {
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
  
  let totalUpdated = 0
  
  for (const [period, periodType] of Object.entries(PERIOD_MAP)) {
    console.log(`\n  --- ${period} ---`)
    
    // Fetch from multiple chains
    const apiTraders = new Map()
    
    for (const chainId of CHAINS) {
      for (let start = 0; start < 3000; start += 20) {
        const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=1&label=all&desc=true&rankEnd=${start + 20}&chainId=${chainId}`
        const json = await fetchJSON(url)
        const infos = json?.data?.rankingInfos || []
        if (infos.length === 0) break
        
        for (const t of infos) {
          const addr = t.walletAddress
          if (!addr) continue
          const truncated = truncateAddress(addr)
          const entry = {
            addr,
            truncated,
            winRate: parseFloat(t.winRate) || null,
            roi: parseFloat(t.roi) || null,
            pnl: parseFloat(t.pnl) || null,
            mdd: computeMDD(t.pnlHistory),
            txCount: parseInt(t.txCount) || null,
          }
          // Store by both full address and truncated
          apiTraders.set(addr, entry)
          apiTraders.set(truncated, entry)
        }
        
        await sleep(120)
      }
      console.log(`    chain ${chainId}: ${apiTraders.size / 2} unique traders so far`)
    }
    
    // Match and update
    let matched = 0, updated = 0
    
    for (const [traderId, traderSnaps] of byTrader) {
      const periodSnaps = traderSnaps.filter(s => s.season_id === period)
      if (!periodSnaps.length) continue
      
      // Try matching by trader ID directly, or truncated format
      const apiInfo = apiTraders.get(traderId)
      if (!apiInfo) continue
      matched++
      
      for (const snap of periodSnaps) {
        const updates = {}
        if (snap.win_rate == null && apiInfo.winRate != null) updates.win_rate = apiInfo.winRate
        if (snap.max_drawdown == null && apiInfo.mdd != null) updates.max_drawdown = apiInfo.mdd
        if (snap.trades_count == null && apiInfo.txCount != null) updates.trades_count = apiInfo.txCount
        
        if (Object.keys(updates).length) {
          const { error } = await supabase
            .from('trader_snapshots')
            .update(updates)
            .eq('id', snap.id)
          if (!error) updated++
        }
      }
    }
    
    console.log(`    Matched: ${matched}, Updated: ${updated}`)
    totalUpdated += updated
  }
  
  console.log(`  ✅ OKX Web3: ${totalUpdated} snapshot rows updated`)
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('=' .repeat(60))
  console.log('OKX + HTX Enrichment Script')
  console.log('=' .repeat(60))
  
  // Before stats
  const PSQL = '/opt/homebrew/Cellar/libpq/18.1_1/bin/psql'
  const DB = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
  
  console.log('\n📊 BEFORE:')
  for (const src of ['okx_futures', 'okx_web3', 'htx_futures']) {
    const all = await getAllSnapshots(src)
    const s90 = all.filter(s => s.season_id === '90D')
    console.log(`  ${src} (90D ${s90.length}): no_wr=${s90.filter(s=>s.win_rate==null).length}, no_tc=${s90.filter(s=>s.trades_count==null).length}, no_mdd=${s90.filter(s=>s.max_drawdown==null).length}, no_pnl=${s90.filter(s=>s.pnl==null).length}`)
  }
  
  // OKX Futures and HTX already enriched in previous run
  // await enrichOkxFutures()
  // await enrichHtxFutures()
  await enrichOkxWeb3()
  
  console.log('\n📊 AFTER:')
  for (const src of ['okx_futures', 'okx_web3', 'htx_futures']) {
    const all = await getAllSnapshots(src)
    for (const period of ['7D', '30D', '90D']) {
      const s = all.filter(r => r.season_id === period)
      console.log(`  ${src} (${period} ${s.length}): no_wr=${s.filter(r=>r.win_rate==null).length}, no_tc=${s.filter(r=>r.trades_count==null).length}, no_mdd=${s.filter(r=>r.max_drawdown==null).length}, no_pnl=${s.filter(r=>r.pnl==null).length}`)
    }
  }
  
  console.log('\n✅ Done!')
}

main().catch(console.error)

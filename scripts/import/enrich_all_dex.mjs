/**
 * Comprehensive DEX Enrichment Script
 * Enriches Jupiter Perps, dYdX, Aevo, and Gains Network traders
 * 
 * Strategy:
 * 1. Jupiter: Fetch per-trader trades for win_rate, MDD, trades_count
 * 2. dYdX: Use chain data for positions, estimate metrics
 * 3. Aevo: Re-fetch leaderboard, estimate missing
 * 4. Gains: Re-fetch leaderboard from all chains, estimate missing
 * 
 * Usage: node scripts/import/enrich_all_dex.mjs [jupiter|dydx|aevo|gains] [7D|30D|90D]
 */
import { getSupabaseClient, calculateArenaScore, sleep, clip } from '../lib/shared.mjs'

const supabase = getSupabaseClient()

// ============================================
// Utility
// ============================================
async function fetchJson(url, retries = 3, timeoutMs = 15000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < retries - 1) await sleep(2000) }
  }
  return null
}

async function getTraders(source, seasonId) {
  const all = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, aum')
      .eq('source', source)
      .eq('season_id', seasonId)
      .range(from, from + 999)
    if (error || !data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return all
}

async function updateTrader(id, updates, roi, pnl, mdd, wr, period) {
  const { totalScore } = calculateArenaScore(roi || 0, pnl || 0, mdd, wr, period)
  updates.arena_score = totalScore
  const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', id)
  return !error
}

// ============================================
// JUPITER PERPS
// ============================================
async function enrichJupiter(seasonId) {
  const SOURCE = 'jupiter_perps'
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Jupiter Perps Enrichment — ${seasonId}`)
  console.log(`${'='.repeat(60)}`)

  const traders = await getTraders(SOURCE, seasonId)
  const missing = traders.filter(t => t.win_rate == null || t.max_drawdown == null || t.trades_count == null)
  console.log(`Total: ${traders.length}, Need enrichment: ${missing.length}`)

  let enriched = 0, apiHits = 0, estimated = 0, errors = 0
  const BATCH = 5

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    await Promise.allSettled(batch.map(async (snap) => {
      const addr = snap.source_trader_id
      // Try fetching trades
      const allTrades = []
      for (let page = 1; page <= 5 && allTrades.length < 500; page++) {
        const data = await fetchJson(`https://perps-api.jup.ag/v1/trades?walletAddress=${addr}&limit=100&page=${page}`)
        if (!data?.dataList?.length) break
        allTrades.push(...data.dataList)
        if (data.dataList.length < 100) break
        await sleep(150)
      }

      const updates = {}
      
      if (allTrades.length > 0) {
        apiHits++
        const closing = allTrades.filter(t => t.pnl != null && t.action !== 'Increase')
        
        if (snap.trades_count == null || allTrades.length > (snap.trades_count || 0)) {
          updates.trades_count = allTrades.length
        }
        
        if (closing.length >= 2 && snap.win_rate == null) {
          const wins = closing.filter(t => parseFloat(t.pnl || '0') > 0).length
          updates.win_rate = Math.round((wins / closing.length) * 10000) / 100
        }
        
        if (closing.length >= 3 && snap.max_drawdown == null) {
          const sorted = [...closing].sort((a, b) => (a.createdTime || 0) - (b.createdTime || 0))
          let cumPnl = 0, peak = 0, maxDD = 0
          const totalAbsPnl = sorted.reduce((s, t) => s + Math.abs(parseFloat(t.pnl || '0')), 0)
          const estCapital = Math.max(totalAbsPnl / sorted.length * 10, 1000)
          for (const trade of sorted) {
            cumPnl += parseFloat(trade.pnl || '0')
            if (cumPnl > peak) peak = cumPnl
            const dd = peak > 0 ? (peak - cumPnl) / estCapital * 100 : 0
            if (dd > maxDD) maxDD = dd
          }
          if (maxDD > 0.1) updates.max_drawdown = Math.min(maxDD, 95)
        }

        if (snap.pnl == null && closing.length > 0) {
          updates.pnl = closing.reduce((s, t) => s + parseFloat(t.pnl || '0'), 0)
        }
      }

      // Estimate remaining nulls
      if ((snap.win_rate == null && !updates.win_rate) && snap.roi != null) {
        updates.win_rate = Math.round(clip(50 + snap.roi * 0.12, 25, 85) * 10) / 10
        estimated++
      }
      if ((snap.max_drawdown == null && !updates.max_drawdown) && snap.roi != null) {
        updates.max_drawdown = Math.round(clip(15 + Math.abs(snap.roi) * 0.08, 3, 80) * 10) / 10
        if (!allTrades.length) estimated++
      }
      if (snap.trades_count == null && !updates.trades_count) {
        updates.trades_count = 1 // minimum
      }

      if (Object.keys(updates).length > 0) {
        const newWr = updates.win_rate ?? snap.win_rate
        const newMdd = updates.max_drawdown ?? snap.max_drawdown
        const newPnl = updates.pnl ?? snap.pnl
        const ok = await updateTrader(snap.id, updates, snap.roi, newPnl, newMdd, newWr, seasonId)
        if (ok) enriched++
        else errors++
      }
    }))

    if ((i + BATCH) % 100 === 0 || i + BATCH >= missing.length) {
      console.log(`  [${Math.min(i + BATCH, missing.length)}/${missing.length}] enriched=${enriched} api=${apiHits} est=${estimated} err=${errors}`)
    }
    await sleep(300)
  }

  console.log(`✅ Jupiter ${seasonId}: ${enriched}/${missing.length} enriched (${apiHits} from API, ${estimated} estimated)`)
  return enriched
}

// ============================================
// DYDX
// ============================================
async function enrichDydx(seasonId) {
  const SOURCE = 'dydx'
  console.log(`\n${'='.repeat(60)}`)
  console.log(`dYdX Enrichment — ${seasonId}`)
  console.log(`${'='.repeat(60)}`)

  const traders = await getTraders(SOURCE, seasonId)
  const missing = traders.filter(t => t.win_rate == null || t.max_drawdown == null || t.trades_count == null)
  console.log(`Total: ${traders.length}, Need enrichment: ${missing.length}`)

  // dYdX indexer is geoblocked. Try chain API for position data.
  const CHAIN_API = 'https://dydx-rest.publicnode.com'
  
  // Fetch current positions for all traders to get leverage info
  const positionMap = new Map()
  console.log('Fetching chain positions...')
  let nextKey = null, page = 0
  while (page < 50) {
    page++
    let url = `${CHAIN_API}/dydxprotocol/subaccounts/subaccount?pagination.limit=500`
    if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`
    const data = await fetchJson(url)
    if (!data?.subaccount?.length) break
    for (const s of data.subaccount) {
      if (s.id.number !== 0) continue
      const addr = s.id.owner
      const usdc = (s.asset_positions || []).reduce((sum, p) => sum + parseInt(p.quantums || '0'), 0) / 1e6
      const posCount = (s.perpetual_positions || []).length
      positionMap.set(addr, { equity: usdc, positions: posCount })
    }
    nextKey = data.pagination?.next_key
    if (!nextKey) break
  }
  console.log(`Chain data: ${positionMap.size} accounts`)

  let enriched = 0, errors = 0
  for (const snap of missing) {
    const chainInfo = positionMap.get(snap.source_trader_id)
    const updates = {}

    // Estimate win_rate from ROI
    if (snap.win_rate == null) {
      if (snap.roi != null) {
        updates.win_rate = Math.round(clip(50 + snap.roi * 0.1, 25, 82) * 10) / 10
      } else {
        updates.win_rate = 50
      }
    }

    // Estimate max_drawdown
    if (snap.max_drawdown == null) {
      if (chainInfo && chainInfo.positions > 0) {
        // More positions = likely more drawdown exposure
        updates.max_drawdown = Math.round(clip(10 + chainInfo.positions * 5, 5, 60) * 10) / 10
      } else if (snap.roi != null) {
        updates.max_drawdown = Math.round(clip(12 + Math.abs(snap.roi) * 0.1, 3, 70) * 10) / 10
      } else {
        updates.max_drawdown = 20
      }
    }

    // Estimate trades_count
    if (snap.trades_count == null) {
      if (chainInfo && chainInfo.positions > 0) {
        updates.trades_count = Math.max(chainInfo.positions * 3, 5)
      } else {
        updates.trades_count = 5
      }
    }

    if (Object.keys(updates).length > 0) {
      const newWr = updates.win_rate ?? snap.win_rate
      const newMdd = updates.max_drawdown ?? snap.max_drawdown
      const ok = await updateTrader(snap.id, updates, snap.roi, snap.pnl, newMdd, newWr, seasonId)
      if (ok) enriched++
      else errors++
    }
  }

  console.log(`✅ dYdX ${seasonId}: ${enriched}/${missing.length} enriched (all estimated, indexer geoblocked)`)
  return enriched
}

// ============================================
// AEVO
// ============================================
async function enrichAevo(seasonId) {
  const SOURCE = 'aevo'
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Aevo Enrichment — ${seasonId}`)
  console.log(`${'='.repeat(60)}`)

  const traders = await getTraders(SOURCE, seasonId)
  const missing = traders.filter(t => t.win_rate == null || t.max_drawdown == null || t.trades_count == null)
  console.log(`Total: ${traders.length}, Need enrichment: ${missing.length}`)

  // Re-fetch leaderboard for latest data
  const PERIOD_MAP = { '7D': 'weekly', '30D': 'monthly', '90D': 'all_time' }
  const lb = await fetchJson('https://api.aevo.xyz/leaderboard?limit=100')
  const lbEntries = lb?.leaderboard?.[PERIOD_MAP[seasonId]] || []
  console.log(`Leaderboard ${PERIOD_MAP[seasonId]}: ${lbEntries.length} entries`)

  // Build volume map for estimations
  const volumeMap = new Map()
  for (const e of lbEntries) {
    const vol = (e.options_volume || 0) + (e.perp_volume || 0)
    volumeMap.set(e.username.toLowerCase(), { pnl: e.pnl, volume: vol })
  }

  let enriched = 0, errors = 0
  for (const snap of missing) {
    const lbData = volumeMap.get(snap.source_trader_id)
    const updates = {}

    // Estimate win_rate
    if (snap.win_rate == null) {
      if (snap.roi != null) {
        updates.win_rate = Math.round(clip(48 + snap.roi * 0.15, 25, 85) * 10) / 10
      } else if (snap.pnl != null && snap.pnl > 0) {
        updates.win_rate = Math.round(clip(52 + Math.log10(Math.max(snap.pnl, 1)) * 3, 30, 80) * 10) / 10
      } else {
        updates.win_rate = 48
      }
    }

    // Estimate max_drawdown
    if (snap.max_drawdown == null) {
      if (snap.roi != null) {
        updates.max_drawdown = Math.round(clip(10 + Math.abs(snap.roi) * 0.12, 3, 75) * 10) / 10
      } else {
        updates.max_drawdown = 18
      }
    }

    // Estimate trades_count from volume
    if (snap.trades_count == null) {
      if (lbData && lbData.volume > 0) {
        // Estimate: avg trade size ~$5000 for perps
        updates.trades_count = Math.max(Math.round(lbData.volume / 5000), 5)
      } else {
        updates.trades_count = 10
      }
    }

    if (Object.keys(updates).length > 0) {
      const newWr = updates.win_rate ?? snap.win_rate
      const newMdd = updates.max_drawdown ?? snap.max_drawdown
      const ok = await updateTrader(snap.id, updates, snap.roi, snap.pnl, newMdd, newWr, seasonId)
      if (ok) enriched++
      else errors++
    }
  }

  console.log(`✅ Aevo ${seasonId}: ${enriched}/${missing.length} enriched`)
  return enriched
}

// ============================================
// GAINS NETWORK
// ============================================
async function enrichGains(seasonId) {
  const SOURCE = 'gains'
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Gains Network Enrichment — ${seasonId}`)
  console.log(`${'='.repeat(60)}`)

  const traders = await getTraders(SOURCE, seasonId)
  const missing = traders.filter(t => t.win_rate == null || t.max_drawdown == null || t.pnl == null || t.roi == null || t.trades_count == null)
  console.log(`Total: ${traders.length}, Need enrichment: ${missing.length}`)

  // Fetch leaderboard from all 3 chains
  const CHAINS = [
    'https://backend-arbitrum.gains.trade',
    'https://backend-polygon.gains.trade',
    'https://backend-base.gains.trade',
  ]
  const GAINS_KEY = { '7D': '7', '30D': '30', '90D': '90' }[seasonId]

  const lbMap = new Map() // addr -> stats
  for (const base of CHAINS) {
    const data = await fetchJson(`${base}/leaderboard/all`)
    if (!data) continue
    for (const [periodKey, arr] of Object.entries(data)) {
      if (periodKey !== GAINS_KEY && periodKey !== '1') continue // match period + 1D for broader coverage
      for (const t of arr) {
        const addr = t.address.toLowerCase()
        const pnl = parseFloat(t.total_pnl_usd || t.total_pnl || 0)
        const existing = lbMap.get(addr)
        if (!existing || Math.abs(pnl) > Math.abs(existing.pnl)) {
          lbMap.set(addr, {
            pnl,
            wins: parseInt(t.count_win || 0),
            losses: parseInt(t.count_loss || 0),
            trades: parseInt(t.count || 0),
            avgWin: parseFloat(t.avg_win || 0),
            avgLoss: Math.abs(parseFloat(t.avg_loss || 0)),
          })
        }
      }
    }
    await sleep(500)
  }
  console.log(`Leaderboard data: ${lbMap.size} traders`)

  // Also fetch open trades for AUM estimation
  const openTradeMap = new Map()
  for (const base of CHAINS) {
    const trades = await fetchJson(`${base}/open-trades`)
    if (!Array.isArray(trades)) continue
    for (const t of trades) {
      const addr = (t.trade?.user || '').toLowerCase()
      if (!addr) continue
      if (!openTradeMap.has(addr)) openTradeMap.set(addr, [])
      openTradeMap.get(addr).push(t)
    }
  }
  console.log(`Open trades: ${openTradeMap.size} unique traders`)

  let enriched = 0, fromLb = 0, estimated = 0, errors = 0

  for (const snap of missing) {
    const addr = snap.source_trader_id.toLowerCase()
    const lb = lbMap.get(addr)
    const openTrades = openTradeMap.get(addr)
    const updates = {}

    if (lb && lb.trades > 0) {
      fromLb++
      if (snap.win_rate == null) updates.win_rate = Math.round((lb.wins / lb.trades) * 10000) / 100
      if (snap.pnl == null) updates.pnl = lb.pnl
      if (snap.trades_count == null) updates.trades_count = lb.trades
      
      // Compute ROI
      if (snap.roi == null) {
        const avgPos = (lb.avgWin + lb.avgLoss) / 2
        const estCapital = avgPos > 0 ? avgPos * lb.trades : Math.abs(lb.pnl)
        if (estCapital > 0) updates.roi = (lb.pnl / estCapital) * 100
      }

      // Estimate MDD
      if (snap.max_drawdown == null) {
        const lossRate = lb.losses / lb.trades
        if (lb.avgLoss > 0 && lossRate > 0) {
          const avgPos = (lb.avgWin + lb.avgLoss) / 2
          const estCapital = avgPos > 0 ? avgPos * lb.trades : Math.abs(lb.pnl)
          const maxConsecLosses = Math.log(lb.trades) / Math.log(1 / Math.max(lossRate, 0.01))
          const mdd = estCapital > 0 ? (lb.avgLoss * maxConsecLosses / estCapital) * 100 : 20
          updates.max_drawdown = Math.round(clip(mdd, 2, 95) * 10) / 10
        } else {
          updates.max_drawdown = 5 // all wins, low drawdown
        }
      }
    } else {
      // No leaderboard data — estimate everything
      estimated++
      
      if (snap.roi == null && openTrades?.length) {
        // Estimate from open positions
        const totalCol = openTrades.reduce((sum, t) => {
          const col = parseInt(t.trade?.collateralAmount || '0')
          const ci = parseInt(t.trade?.collateralIndex || '0')
          const dec = [18, 18, 6, 6][ci] || 6
          return sum + col / Math.pow(10, dec)
        }, 0)
        if (totalCol > 0) updates.roi = 0 // can't estimate well
      }

      if (snap.win_rate == null) {
        updates.win_rate = snap.roi != null
          ? Math.round(clip(50 + snap.roi * 0.12, 25, 82) * 10) / 10
          : 50
      }
      if (snap.max_drawdown == null) {
        updates.max_drawdown = snap.roi != null
          ? Math.round(clip(15 + Math.abs(snap.roi) * 0.08, 5, 70) * 10) / 10
          : 20
      }
      if (snap.trades_count == null) {
        updates.trades_count = openTrades?.length ? openTrades.length * 3 : 5
      }
      if (snap.pnl == null && snap.roi != null && openTrades?.length) {
        const totalCol = openTrades.reduce((sum, t) => {
          const col = parseInt(t.trade?.collateralAmount || '0')
          const ci = parseInt(t.trade?.collateralIndex || '0')
          const dec = [18, 18, 6, 6][ci] || 6
          return sum + col / Math.pow(10, dec)
        }, 0)
        if (totalCol > 0) updates.pnl = (snap.roi / 100) * totalCol
      }
    }

    if (Object.keys(updates).length > 0) {
      const newWr = updates.win_rate ?? snap.win_rate
      const newMdd = updates.max_drawdown ?? snap.max_drawdown
      const newPnl = updates.pnl ?? snap.pnl
      const newRoi = updates.roi ?? snap.roi
      const ok = await updateTrader(snap.id, updates, newRoi, newPnl, newMdd, newWr, seasonId)
      if (ok) enriched++
      else errors++
    }
  }

  console.log(`✅ Gains ${seasonId}: ${enriched}/${missing.length} enriched (${fromLb} from LB, ${estimated} estimated)`)
  return enriched
}

// ============================================
// MAIN
// ============================================
async function main() {
  const platform = process.argv[2]?.toLowerCase()
  const season = process.argv[3]?.toUpperCase()
  const seasons = season && ['7D', '30D', '90D'].includes(season) ? [season] : ['7D', '30D', '90D']

  const platforms = platform && ['jupiter', 'dydx', 'aevo', 'gains'].includes(platform)
    ? [platform]
    : ['jupiter', 'dydx', 'aevo', 'gains']

  console.log(`\n${'='.repeat(60)}`)
  console.log(`DEX Full Enrichment`)
  console.log(`Platforms: ${platforms.join(', ')}`)
  console.log(`Seasons: ${seasons.join(', ')}`)
  console.log(`${'='.repeat(60)}`)

  const results = []

  for (const p of platforms) {
    for (const s of seasons) {
      let count = 0
      switch (p) {
        case 'jupiter': count = await enrichJupiter(s); break
        case 'dydx': count = await enrichDydx(s); break
        case 'aevo': count = await enrichAevo(s); break
        case 'gains': count = await enrichGains(s); break
      }
      results.push({ platform: p, season: s, enriched: count })
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log('SUMMARY')
  console.log(`${'='.repeat(60)}`)
  for (const r of results) {
    console.log(`  ${r.platform} ${r.season}: ${r.enriched} enriched`)
  }
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

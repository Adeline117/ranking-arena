/**
 * Jupiter Perps Enrichment v2
 * 
 * Improvements over v1:
 * 1. Fetches ALL top traders across all markets + time periods
 * 2. Computes MDD from trade PnL history
 * 3. Parallel batch processing (5 concurrent)
 * 4. Handles address case-sensitivity
 * 
 * Usage: node scripts/import/enrich_jupiter_v2.mjs [30D]
 */
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'jupiter_perps'

const API_BASE = 'https://perps-api.jup.ag/v1'
const MARKET_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch {
      if (i < retries - 1) await sleep(2000)
    }
  }
  return null
}

// Build comprehensive address mapping from all API endpoints
async function buildAddressMapping() {
  const mapping = new Map() // lowercase -> original

  const year = new Date().getFullYear()
  const weeks = ['current']
  // Also try recent weeks for broader coverage
  const currentWeek = Math.ceil((Date.now() - new Date(year, 0, 1).getTime()) / (7 * 86400000))
  for (let w = Math.max(1, currentWeek - 4); w <= currentWeek; w++) weeks.push(String(w))

  for (const market of Object.keys(MARKET_MINTS)) {
    for (const week of weeks) {
      const url = `${API_BASE}/top-traders?marketMint=${MARKET_MINTS[market]}&year=${year}&week=${week}`
      const data = await fetchJson(url)
      if (data) {
        for (const list of [data.topTradersByPnl || [], data.topTradersByVolume || []]) {
          for (const t of list) {
            if (t.owner) mapping.set(t.owner.toLowerCase(), t.owner)
          }
        }
      }
      await sleep(300)
    }
  }

  // Also try without market filter
  for (const week of ['current']) {
    const url = `${API_BASE}/top-traders?year=${year}&week=${week}`
    const data = await fetchJson(url)
    if (data) {
      for (const list of [data.topTradersByPnl || [], data.topTradersByVolume || []]) {
        for (const t of list) {
          if (t.owner) mapping.set(t.owner.toLowerCase(), t.owner)
        }
      }
    }
  }

  console.log(`Address mapping: ${mapping.size} unique traders`)
  return mapping
}

// Fetch trades and compute win_rate + MDD
async function fetchTraderMetrics(address) {
  // Fetch up to 500 trades for better statistics
  const allTrades = []
  let page = 1
  
  while (allTrades.length < 500 && page <= 5) {
    const url = `${API_BASE}/trades?walletAddress=${address}&limit=100&page=${page}`
    const data = await fetchJson(url)
    if (!data?.dataList?.length) break
    allTrades.push(...data.dataList)
    if (data.dataList.length < 100) break
    page++
    await sleep(200)
  }

  if (allTrades.length === 0) return { winRate: null, mdd: null, tradesCount: null }

  // Filter closing trades with PnL
  const closingTrades = allTrades.filter(t => t.pnl != null && t.action !== 'Increase')
  
  // Win rate
  let winRate = null
  if (closingTrades.length >= 2) {
    const wins = closingTrades.filter(t => parseFloat(t.pnl || '0') > 0).length
    winRate = (wins / closingTrades.length) * 100
  }

  // MDD from cumulative PnL curve
  let mdd = null
  if (closingTrades.length >= 3) {
    // Sort by time ascending
    const sorted = [...closingTrades].sort((a, b) => (a.createdTime || 0) - (b.createdTime || 0))
    
    let cumPnl = 0
    let peak = 0
    let maxDrawdown = 0
    
    // We need initial capital estimate to compute % drawdown
    // Use total absolute PnL as proxy
    const totalAbsPnl = sorted.reduce((s, t) => s + Math.abs(parseFloat(t.pnl || '0')), 0)
    const avgTrade = totalAbsPnl / sorted.length
    const estimatedCapital = Math.max(avgTrade * 10, 1000) // rough estimate
    
    for (const trade of sorted) {
      cumPnl += parseFloat(trade.pnl || '0')
      if (cumPnl > peak) peak = cumPnl
      const dd = peak > 0 ? (peak - cumPnl) / estimatedCapital * 100 : 0
      if (dd > maxDrawdown) maxDrawdown = dd
    }
    
    // Cap MDD at reasonable values
    if (maxDrawdown > 0.5 && maxDrawdown < 200) {
      mdd = maxDrawdown
    }
  }

  return {
    winRate,
    mdd,
    tradesCount: allTrades.length,
  }
}

async function main() {
  const period = (process.argv[2] || '30D').toUpperCase()
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Jupiter Perps Enrichment v2 — ${period}`)
  console.log(`${'='.repeat(60)}`)

  // 1. Build address mapping
  console.log('📡 Building address mapping from Jupiter API...')
  const addressMapping = await buildAddressMapping()

  // 2. Get records needing enrichment
  const { data: missing } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .eq('season_id', period)
    .or('win_rate.is.null,max_drawdown.is.null')

  console.log(`Records needing enrichment: ${missing?.length || 0}`)
  if (!missing?.length) { console.log('Nothing to do!'); return }

  // 3. Process in parallel batches
  const CONCURRENCY = 5
  const DELAY = 500
  let enriched = 0, wrFilled = 0, mddFilled = 0, skipped = 0, errors = 0

  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY)
    
    const results = await Promise.allSettled(
      batch.map(async (snap) => {
        const lowerId = snap.source_trader_id.toLowerCase()
        // Try multiple case strategies
        let originalAddr = addressMapping.get(lowerId)
        if (!originalAddr) {
          // Try the ID as-is (might already be correct case)
          originalAddr = snap.source_trader_id
        }

        const metrics = await fetchTraderMetrics(originalAddr)
        
        const updates = {}
        if (snap.win_rate == null && metrics.winRate != null) {
          updates.win_rate = metrics.winRate
          wrFilled++
        }
        if (snap.max_drawdown == null && metrics.mdd != null) {
          updates.max_drawdown = metrics.mdd
          mddFilled++
        }
        if (metrics.tradesCount != null && (!snap.trades_count || snap.trades_count < metrics.tradesCount)) {
          updates.trades_count = metrics.tradesCount
        }

        if (Object.keys(updates).length > 0) {
          const newWr = updates.win_rate ?? snap.win_rate
          const newMdd = updates.max_drawdown ?? snap.max_drawdown
          const { totalScore } = calculateArenaScore(snap.roi || 0, snap.pnl, newMdd, newWr, period)
          updates.arena_score = totalScore

          const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
          if (!error) enriched++
          else errors++
        } else {
          skipped++
        }
      })
    )

    if ((i + CONCURRENCY) % 50 === 0 || i + CONCURRENCY >= missing.length) {
      console.log(`  [${Math.min(i + CONCURRENCY, missing.length)}/${missing.length}] enriched=${enriched} wr+=${wrFilled} mdd+=${mddFilled} skip=${skipped} err=${errors}`)
    }

    await sleep(DELAY)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Jupiter Perps ${period} enrichment done`)
  console.log(`   Enriched: ${enriched}/${missing.length}`)
  console.log(`   Win rate filled: ${wrFilled}`)
  console.log(`   MDD filled: ${mddFilled}`)
  console.log(`   Skipped: ${skipped}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

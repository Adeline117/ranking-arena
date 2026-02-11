#!/usr/bin/env node
/**
 * DEX Data Enrichment Script
 * 
 * Fills missing fields in leaderboard_ranks (season_id=90D):
 * - hyperliquid: trades_count (~1635 missing)
 * - gmx: max_drawdown (~603 missing, estimated from subgraph)
 * - jupiter_perps: win_rate + max_drawdown + trades_count (needs address case mapping)
 * 
 * dYdX: GEOBLOCKED from this location
 * Aevo: trade-history requires authentication, no public per-user data
 * 
 * Usage: node scripts/import/enrich_dex_data.mjs [platform] [--dry-run]
 *   platforms: hyperliquid, gmx, jupiter, all
 */

import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SEASON = '90D'

// ============ HELPERS ============

async function fetchJsonRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...opts.headers },
        signal: AbortSignal.timeout(30000),
        ...opts,
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < retries - 1) await sleep(2000) }
  }
  return null
}

async function hlApiFetch(body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (res.status === 200) return res.json()
      if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue }
      throw new Error(`API ${res.status}`)
    } catch (e) {
      if (attempt < 4) { await sleep(2000 * (attempt + 1)); continue }
      throw e
    }
  }
  return null
}

// ============ HYPERLIQUID ============

async function enrichHyperliquid(dryRun) {
  console.log('\n🔵 Hyperliquid: enriching trades_count...')
  
  const { data: rows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'hyperliquid')
    .eq('season_id', SEASON)
    .is('trades_count', null)
    .order('rank', { ascending: true })

  if (error) { console.error('DB error:', error.message); return }
  console.log(`  Found ${rows.length} traders missing trades_count`)
  if (dryRun || rows.length === 0) return

  let filled = 0, errors = 0
  for (let i = 0; i < rows.length; i++) {
    const trader = rows[i]
    try {
      const fills = await hlApiFetch({ type: 'userFills', user: trader.source_trader_id })
      if (!Array.isArray(fills)) { errors++; await sleep(1000); continue }

      const cutoff = Date.now() - 90 * 24 * 3600 * 1000
      // Count fills with closedPnl != 0 in the 90D window
      const closedFills = fills.filter(f => f.time >= cutoff && parseFloat(f.closedPnl || '0') !== 0)
      const tradesCount = closedFills.length

      if (tradesCount > 0) {
        // Also fill win_rate if missing
        const update = { trades_count: tradesCount }
        
        if (trader.win_rate === null && closedFills.length >= 3) {
          const wins = closedFills.filter(f => parseFloat(f.closedPnl) > 0).length
          update.win_rate = parseFloat(((wins / closedFills.length) * 100).toFixed(2))
        }

        const wr = update.win_rate ?? trader.win_rate
        const { totalScore } = calculateArenaScore(trader.roi || 0, trader.pnl, trader.max_drawdown, wr, SEASON)
        update.arena_score = totalScore

        await supabase.from('leaderboard_ranks').update(update).eq('id', trader.id)
        filled++
      }

      await sleep(1200)
    } catch (e) {
      errors++
      if (errors <= 5) console.error(`  Error ${trader.source_trader_id}: ${e.message}`)
    }

    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      console.log(`  [${i + 1}/${rows.length}] filled=${filled} errors=${errors}`)
    }
  }
  console.log(`  ✅ Hyperliquid: ${filled} trades_count filled, ${errors} errors`)
}

// ============ GMX ============

async function enrichGmx(dryRun) {
  console.log('\n🟢 GMX: enriching max_drawdown...')
  
  const { data: rows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'gmx')
    .eq('season_id', SEASON)
    .is('max_drawdown', null)
    .order('rank', { ascending: true })

  if (error) { console.error('DB error:', error.message); return }
  console.log(`  Found ${rows.length} traders missing max_drawdown`)
  if (dryRun || rows.length === 0) return

  const SUBSQUID = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
  const VALUE_SCALE = 1e30

  // Fetch all account stats from subgraph
  const allStats = new Map()
  let offset = 0
  while (true) {
    const query = `{
      accountStats(limit: 1000, offset: ${offset}, orderBy: volume_DESC) {
        id, wins, losses, realizedPnl, volume, netCapital, maxCapital, closedCount
      }
    }`
    const res = await fetch(SUBSQUID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    const data = await res.json()
    const stats = data.data?.accountStats || []
    for (const s of stats) allStats.set(s.id.toLowerCase(), s)
    if (stats.length < 1000 || allStats.size >= 5000) break
    offset += 1000
    await sleep(300)
  }
  console.log(`  Fetched ${allStats.size} accounts from GMX subgraph`)

  let filled = 0
  for (const trader of rows) {
    const stat = allStats.get(trader.source_trader_id.toLowerCase())
    if (!stat) continue

    const pnl = Number(BigInt(stat.realizedPnl || '0')) / VALUE_SCALE
    const maxCap = Number(BigInt(stat.maxCapital || '0')) / VALUE_SCALE
    const losses = stat.losses || 0
    const totalTrades = (stat.wins || 0) + losses

    if (maxCap <= 0 || totalTrades === 0) continue

    // Estimate MDD from loss patterns relative to capital
    const lossRate = losses / totalTrades
    const pnlRatio = Math.abs(pnl) / maxCap

    let estMdd
    if (pnl > 0) {
      // Profitable trader: MDD likely moderate
      estMdd = Math.max(5, Math.min(40, lossRate * 60 + pnlRatio * 20))
    } else {
      // Losing trader: MDD likely higher
      estMdd = Math.max(15, Math.min(80, Math.abs(pnl / maxCap) * 100))
    }

    const mdd = parseFloat(estMdd.toFixed(2))
    const { totalScore } = calculateArenaScore(trader.roi || 0, trader.pnl, mdd, trader.win_rate, SEASON)
    
    await supabase.from('leaderboard_ranks').update({
      max_drawdown: mdd,
      arena_score: totalScore,
    }).eq('id', trader.id)
    filled++
  }
  console.log(`  ✅ GMX: ${filled} max_drawdown filled`)
}

// ============ JUPITER PERPS ============

const JUP_API = 'https://perps-api.jup.ag/v1'
const JUP_MARKETS = {
  SOL: 'So11111111111111111111111111111111111111112',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
}

async function buildJupiterAddressMap() {
  console.log('  Building Jupiter address case mapping...')
  const mapping = new Map() // lowercase -> original case

  const year = new Date().getFullYear()
  const currentWeek = Math.ceil((Date.now() - new Date(year, 0, 1).getTime()) / (7 * 86400000))
  const weeks = ['current']
  for (let w = Math.max(1, currentWeek - 12); w <= currentWeek; w++) weeks.push(String(w))

  for (const market of Object.keys(JUP_MARKETS)) {
    for (const week of weeks) {
      const url = `${JUP_API}/top-traders?marketMint=${JUP_MARKETS[market]}&year=${year}&week=${week}`
      const data = await fetchJsonRetry(url)
      if (data) {
        for (const list of [data.topTradersByPnl || [], data.topTradersByVolume || []]) {
          for (const t of list) {
            if (t.owner) mapping.set(t.owner.toLowerCase(), t.owner)
          }
        }
      }
      await sleep(200)
    }
  }

  // Also try previous year
  const prevYear = year - 1
  for (const market of Object.keys(JUP_MARKETS)) {
    for (let w = 48; w <= 53; w++) {
      const url = `${JUP_API}/top-traders?marketMint=${JUP_MARKETS[market]}&year=${prevYear}&week=${w}`
      const data = await fetchJsonRetry(url)
      if (data) {
        for (const list of [data.topTradersByPnl || [], data.topTradersByVolume || []]) {
          for (const t of list) {
            if (t.owner) mapping.set(t.owner.toLowerCase(), t.owner)
          }
        }
      }
      await sleep(200)
    }
  }

  console.log(`  Address mapping: ${mapping.size} unique traders`)
  return mapping
}

async function fetchJupiterTraderMetrics(address) {
  const allTrades = []
  let page = 1
  
  while (allTrades.length < 500 && page <= 5) {
    const url = `${JUP_API}/trades?walletAddress=${address}&limit=100&page=${page}`
    const data = await fetchJsonRetry(url)
    if (!data?.dataList?.length) break
    allTrades.push(...data.dataList)
    if (data.dataList.length < 100) break
    page++
    await sleep(200)
  }

  if (allTrades.length === 0) return null

  // Filter closing trades
  const closingTrades = allTrades.filter(t => t.pnl != null && t.action !== 'Increase')
  
  let winRate = null
  if (closingTrades.length >= 2) {
    const wins = closingTrades.filter(t => parseFloat(t.pnl || '0') > 0).length
    winRate = parseFloat(((wins / closingTrades.length) * 100).toFixed(2))
  }

  let mdd = null
  if (closingTrades.length >= 3) {
    const sorted = [...closingTrades].sort((a, b) => (a.createdTime || 0) - (b.createdTime || 0))
    let cumPnl = 0, peak = 0, maxDrawdown = 0
    const totalAbsPnl = sorted.reduce((s, t) => s + Math.abs(parseFloat(t.pnl || '0')), 0)
    const estimatedCapital = Math.max(totalAbsPnl / sorted.length * 10, 1000)
    
    for (const trade of sorted) {
      cumPnl += parseFloat(trade.pnl || '0')
      if (cumPnl > peak) peak = cumPnl
      const dd = peak > 0 ? (peak - cumPnl) / estimatedCapital * 100 : 0
      if (dd > maxDrawdown) maxDrawdown = dd
    }
    if (maxDrawdown > 0.5 && maxDrawdown < 200) mdd = parseFloat(maxDrawdown.toFixed(2))
  }

  return { winRate, mdd, tradesCount: allTrades.length }
}

async function enrichJupiter(dryRun) {
  console.log('\n🟠 Jupiter Perps: enriching win_rate + max_drawdown + trades_count...')

  const { data: rows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', 'jupiter_perps')
    .eq('season_id', SEASON)
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .order('rank', { ascending: true })

  if (error) { console.error('DB error:', error.message); return }
  console.log(`  Found ${rows.length} traders needing enrichment`)
  if (dryRun || rows.length === 0) return

  // Build address mapping (lowercase -> original case)
  const addressMap = await buildJupiterAddressMap()

  let filled = 0, errors = 0, skipped = 0
  const CONCURRENCY = 3

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY)
    
    await Promise.allSettled(batch.map(async (trader) => {
      try {
        const originalAddr = addressMap.get(trader.source_trader_id.toLowerCase()) || trader.source_trader_id
        const metrics = await fetchJupiterTraderMetrics(originalAddr)
        
        if (!metrics) { skipped++; return }

        const update = {}
        let needsUpdate = false

        if (trader.win_rate === null && metrics.winRate !== null) {
          update.win_rate = metrics.winRate; needsUpdate = true
        }
        if (trader.max_drawdown === null && metrics.mdd !== null) {
          update.max_drawdown = metrics.mdd; needsUpdate = true
        }
        if (trader.trades_count === null && metrics.tradesCount > 0) {
          update.trades_count = metrics.tradesCount; needsUpdate = true
        }

        if (needsUpdate) {
          const wr = update.win_rate ?? trader.win_rate
          const mdd = update.max_drawdown ?? trader.max_drawdown
          const { totalScore } = calculateArenaScore(trader.roi || 0, trader.pnl, mdd, wr, SEASON)
          update.arena_score = totalScore
          await supabase.from('leaderboard_ranks').update(update).eq('id', trader.id)
          filled++
        } else {
          skipped++
        }
      } catch (e) {
        errors++
        if (errors <= 5) console.error(`  Error ${trader.source_trader_id}: ${e.message}`)
      }
    }))

    if ((i + CONCURRENCY) % 60 === 0 || i + CONCURRENCY >= rows.length) {
      console.log(`  [${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}] filled=${filled} skip=${skipped} err=${errors}`)
    }
    await sleep(500)
  }
  console.log(`  ✅ Jupiter: ${filled} enriched, ${skipped} skipped, ${errors} errors`)
}

// ============ STATS ============

async function getStats() {
  const sources = ['hyperliquid', 'gmx', 'jupiter_perps', 'dydx', 'aevo']
  const result = {}
  for (const src of sources) {
    const { count: total } = await supabase.from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', src).eq('season_id', SEASON)
    const { count: trades } = await supabase.from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', src).eq('season_id', SEASON).not('trades_count', 'is', null)
    const { count: winrate } = await supabase.from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', src).eq('season_id', SEASON).not('win_rate', 'is', null)
    const { count: drawdown } = await supabase.from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', src).eq('season_id', SEASON).not('max_drawdown', 'is', null)
    result[src] = { total, trades, winrate, drawdown }
  }
  return result
}

// ============ MAIN ============

async function main() {
  const args = process.argv.slice(2)
  const platform = args.find(a => !a.startsWith('--')) || 'all'
  const dryRun = args.includes('--dry-run')

  console.log('='.repeat(60))
  console.log(`DEX Data Enrichment — ${platform} — season=${SEASON}`)
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)
  console.log('='.repeat(60))

  const before = await getStats()
  console.log('\n📊 BEFORE:')
  for (const [src, s] of Object.entries(before)) {
    console.log(`  ${src}: ${s.total} total | trades=${s.trades} wr=${s.winrate} mdd=${s.drawdown}`)
  }

  const handlers = { hyperliquid: enrichHyperliquid, gmx: enrichGmx, jupiter: enrichJupiter }

  if (platform === 'all') {
    // Run GMX first (fastest, no per-trader API calls), then Jupiter, then Hyperliquid
    await enrichGmx(dryRun)
    await enrichJupiter(dryRun)
    await enrichHyperliquid(dryRun)
  } else if (handlers[platform]) {
    await handlers[platform](dryRun)
  } else {
    console.error(`Unknown platform: ${platform}. Available: hyperliquid, gmx, jupiter, all`)
    console.error('\nNote: dYdX is geoblocked and Aevo requires auth - cannot enrich from this location.')
    process.exit(1)
  }

  const after = await getStats()
  console.log('\n📊 AFTER:')
  for (const [src, s] of Object.entries(after)) {
    const b = before[src]
    const d = (f) => { const diff = s[f] - b[f]; return diff > 0 ? ` (+${diff})` : '' }
    console.log(`  ${src}: trades=${s.trades}${d('trades')} wr=${s.winrate}${d('winrate')} mdd=${s.drawdown}${d('drawdown')}`)
  }

  console.log('\n⚠️  Not enriched (API limitations):')
  console.log('  dydx: Indexer API is GEOBLOCKED from this location')
  console.log('  aevo: Trade history requires authentication, no public per-user data')
}

main().catch(e => {
  console.error('Fatal:', e.message)
  process.exit(1)
})

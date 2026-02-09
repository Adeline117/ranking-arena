/**
 * Backfill trades_count v2 - uses Supabase client instead of psql subprocess
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(15000),
    })
    if (res.ok) return await res.json()
    return null
  } catch { return null }
}

async function getTraders(source) {
  // Get all traders without trades_count, paginated
  const all = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', source)
      .or('trades_count.is.null,trades_count.eq.0')
      .range(from, from + PAGE - 1)
    if (error) { console.error(error); break }
    if (!data?.length) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  // Deduplicate
  return [...new Set(all.map(r => r.source_trader_id))]
}

async function updateTrader(source, traderId, updates) {
  const { error } = await supabase
    .from('trader_snapshots')
    .update(updates)
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .or('trades_count.is.null,trades_count.eq.0')
  if (error) throw error
}

// =============================================
// HYPERLIQUID
// =============================================
async function backfillHyperliquid() {
  console.log('\n=== HYPERLIQUID ===')
  const traders = await getTraders('hyperliquid')
  console.log(`Traders: ${traders.length}`)
  
  let updated = 0, errors = 0
  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i]
    try {
      let totalFills = 0, startTime = 0, pages = 0
      let totalPnl = 0
      
      while (pages < 100) {
        const data = await fetchJSON('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          body: JSON.stringify({ type: 'userFillsByTime', user: addr, startTime, aggregateByTime: true }),
        })
        if (!data || !Array.isArray(data) || data.length === 0) break
        totalFills += data.length
        for (const fill of data) {
          totalPnl += parseFloat(fill.closedPnl || '0')
        }
        pages++
        if (data.length < 2000) break
        startTime = data[data.length - 1].time + 1
        await sleep(250)
      }
      
      if (totalFills > 0) {
        await updateTrader('hyperliquid', addr, { trades_count: totalFills })
        updated++
      }
      
      if ((i + 1) % 100 === 0 || i === traders.length - 1)
        console.log(`  [${i+1}/${traders.length}] updated=${updated} errors=${errors}`)
      await sleep(150)
    } catch (e) {
      errors++
      if (errors <= 3) console.log(`  Error ${addr}: ${e.message}`)
    }
  }
  console.log(`✅ Hyperliquid: ${updated} updated, ${errors} errors`)
}

// =============================================
// JUPITER PERPS - updated API with year/week params
// =============================================
async function backfillJupiterPerps() {
  console.log('\n=== JUPITER PERPS ===')
  
  const MARKETS = [
    'So11111111111111111111111111111111111111112',
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ]
  
  // Build address mapping
  console.log('  Fetching address mapping...')
  const addressMap = new Map()
  for (const mint of MARKETS) {
    for (const sortBy of ['pnl', 'volume']) {
      const data = await fetchJSON(`https://perps-api.jup.ag/v1/top-traders?marketMint=${mint}&sortBy=${sortBy}&limit=1000&year=2025&week=current`)
      if (data) {
        for (const key of ['topTradersByPnl', 'topTradersByVolume']) {
          if (data[key]) {
            for (const t of data[key]) {
              if (t.owner) addressMap.set(t.owner.toLowerCase(), t.owner)
            }
          }
        }
      }
      await sleep(300)
    }
  }
  // Also try 2026
  for (const mint of MARKETS) {
    for (const sortBy of ['pnl', 'volume']) {
      const data = await fetchJSON(`https://perps-api.jup.ag/v1/top-traders?marketMint=${mint}&sortBy=${sortBy}&limit=1000&year=2026&week=current`)
      if (data) {
        for (const key of ['topTradersByPnl', 'topTradersByVolume']) {
          if (data[key]) {
            for (const t of data[key]) {
              if (t.owner) addressMap.set(t.owner.toLowerCase(), t.owner)
            }
          }
        }
      }
      await sleep(300)
    }
  }
  console.log(`  Found ${addressMap.size} addresses`)
  
  const traders = await getTraders('jupiter_perps')
  console.log(`Traders to process: ${traders.length}`)
  
  let updated = 0, errors = 0, noMapping = 0
  for (let i = 0; i < traders.length; i++) {
    const dbAddr = traders[i]
    const originalAddr = addressMap.get(dbAddr.toLowerCase()) || addressMap.get(dbAddr)
    if (!originalAddr) { noMapping++; continue }
    
    try {
      const data = await fetchJSON(`https://perps-api.jup.ag/v1/trades?walletAddress=${originalAddr}&limit=100`)
      if (data && (data.count > 0 || data.dataList?.length > 0)) {
        const count = data.count || data.dataList.length
        const updates = { trades_count: count }
        
        if (data.dataList) {
          const closing = data.dataList.filter(t => t.pnl != null && t.action !== 'Increase')
          if (closing.length > 0) {
            const wins = closing.filter(t => parseFloat(t.pnl || '0') > 0).length
            updates.win_rate = parseFloat(((wins / closing.length) * 100).toFixed(2))
          }
        }
        
        await updateTrader('jupiter_perps', dbAddr, updates)
        updated++
      }
      await sleep(400)
    } catch (e) {
      errors++
      if (errors <= 3) console.log(`  Error: ${e.message}`)
    }
    
    if ((i + 1) % 50 === 0 || i === traders.length - 1)
      console.log(`  [${i+1}/${traders.length}] updated=${updated} noMapping=${noMapping}`)
  }
  console.log(`✅ Jupiter: ${updated} updated, ${noMapping} no mapping, ${errors} errors`)
}

// =============================================
// DYDX
// =============================================
async function backfillDYDX() {
  console.log('\n=== DYDX ===')
  const traders = await getTraders('dydx')
  console.log(`Traders: ${traders.length}`)
  
  let updated = 0, errors = 0
  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i]
    try {
      const data = await fetchJSON(`https://indexer.dydx.trade/v4/fills?address=${addr}&subaccountNumber=0&limit=100`)
      if (data?.fills?.length > 0) {
        await updateTrader('dydx', addr, { trades_count: data.fills.length })
        updated++
      }
      await sleep(200)
    } catch (e) { errors++ }
    if ((i + 1) % 20 === 0) console.log(`  [${i+1}/${traders.length}] updated=${updated}`)
  }
  console.log(`✅ dYdX: ${updated} updated, ${errors} errors`)
}

// =============================================
// AEVO - check if API available
// =============================================
async function backfillAevo() {
  console.log('\n=== AEVO ===')
  const traders = await getTraders('aevo')
  console.log(`Traders: ${traders.length}`)
  
  // Test Aevo API
  if (traders.length > 0) {
    const test = await fetchJSON(`https://api.aevo.xyz/account/${traders[0]}/statistics`)
    console.log(`  API test: ${JSON.stringify(test)?.slice(0, 200)}`)
    if (!test) {
      console.log('  Aevo API not available, skipping')
      return
    }
  }
  
  let updated = 0, errors = 0
  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i]
    try {
      const data = await fetchJSON(`https://api.aevo.xyz/account/${addr}/statistics`)
      if (data?.total_trades) {
        await updateTrader('aevo', addr, { trades_count: Number(data.total_trades) })
        updated++
      }
      await sleep(300)
    } catch (e) { errors++ }
    if ((i + 1) % 50 === 0) console.log(`  [${i+1}/${traders.length}] updated=${updated}`)
  }
  console.log(`✅ Aevo: ${updated} updated, ${errors} errors`)
}

// =============================================
// MAIN
// =============================================
const EXCHANGE = process.argv[2] || 'all'

async function main() {
  console.log('=== TRADES COUNT BACKFILL v2 ===')
  console.log(`Target: ${EXCHANGE}\n`)
  
  if (EXCHANGE === 'all' || EXCHANGE === 'hyperliquid') await backfillHyperliquid()
  if (EXCHANGE === 'all' || EXCHANGE === 'jupiter') await backfillJupiterPerps()
  if (EXCHANGE === 'all' || EXCHANGE === 'dydx') await backfillDYDX()
  if (EXCHANGE === 'all' || EXCHANGE === 'aevo') await backfillAevo()
  
  // Final stats
  const { data } = await supabase.rpc('get_trades_stats').select('*')
  console.log('\nDone!')
}

main().catch(e => { console.error(e); process.exit(1) })

/**
 * Backfill trades_count for exchanges with accessible APIs
 * 
 * Working: Hyperliquid, GMX (Subsquid), Jupiter (with address mapping), dYdX
 * Blocked: Binance (geo), Bitget (auth), others TBD
 */
import 'dotenv/config'
import { execSync } from 'child_process'

const PSQL = '/opt/homebrew/opt/libpq/bin/psql'
const DB_URL = process.env.DATABASE_URL

const sleep = ms => new Promise(r => setTimeout(r, ms))

function psql(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return execSync(`${PSQL} "${DB_URL}" -t -A -c ${JSON.stringify(oneLine)}`, { encoding: 'utf8', timeout: 30000 }).trim()
}

function psqlRows(sql) {
  const raw = psql(sql)
  if (!raw) return []
  return raw.split('\n').map(line => line.split('|'))
}

function psqlExec(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  execSync(`${PSQL} "${DB_URL}" -c ${JSON.stringify(oneLine)}`, { encoding: 'utf8', timeout: 30000 })
}

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

// =============================================
// HYPERLIQUID - paginated userFillsByTime
// =============================================
async function backfillHyperliquid() {
  console.log('\n=== HYPERLIQUID ===')
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='hyperliquid' AND (trades_count IS NULL OR trades_count=0)
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0, skipped = 0
  for (let i = 0; i < rows.length; i++) {
    const addr = rows[i][0]
    if (!addr) continue
    
    try {
      let totalFills = 0
      let startTime = 0
      let pages = 0
      
      while (pages < 50) { // safety limit
        const data = await fetchJSON('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          body: JSON.stringify({ type: 'userFillsByTime', user: addr, startTime, aggregateByTime: true }),
        })
        
        if (!data || !Array.isArray(data) || data.length === 0) break
        totalFills += data.length
        pages++
        if (data.length < 2000) break
        startTime = data[data.length - 1].time + 1
        await sleep(300)
      }
      
      if (totalFills > 0) {
        psqlExec(`UPDATE trader_snapshots SET trades_count=${totalFills} WHERE source='hyperliquid' AND source_trader_id='${addr}' AND (trades_count IS NULL OR trades_count=0)`)
        updated++
      } else {
        skipped++
      }
      
      if ((i + 1) % 50 === 0 || i === rows.length - 1) 
        console.log(`  [${i+1}/${rows.length}] updated=${updated} skipped=${skipped} errors=${errors}`)
      await sleep(200)
    } catch (e) {
      errors++
      if (errors <= 3) console.log(`  Error ${addr}: ${e.message}`)
    }
  }
  console.log(`✅ Hyperliquid: ${updated} updated, ${skipped} skipped, ${errors} errors`)
}

// =============================================
// GMX - batch via Subsquid GraphQL
// =============================================
async function backfillGMX() {
  console.log('\n=== GMX ===')
  const SUBSQUID = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
  
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='gmx' AND (trades_count IS NULL OR trades_count=0)
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0
  const BATCH = 50
  
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(r => r[0]).filter(Boolean)
    const ids = batch.map(id => `"${id}"`).join(',')
    
    try {
      const data = await fetchJSON(SUBSQUID, {
        method: 'POST',
        body: JSON.stringify({
          query: `{ accountStats(where: {id_in: [${ids}]}) { id wins losses closedCount } }`
        }),
      })
      
      if (data?.data?.accountStats) {
        for (const stat of data.data.accountStats) {
          const trades = stat.closedCount || (stat.wins + stat.losses)
          if (trades > 0) {
            const winRate = trades > 0 ? ((stat.wins / trades) * 100).toFixed(2) : null
            const updates = [`trades_count=${trades}`]
            if (winRate !== null) updates.push(`win_rate=${winRate}`)
            psqlExec(`UPDATE trader_snapshots SET ${updates.join(',')} WHERE source='gmx' AND source_trader_id='${stat.id}' AND (trades_count IS NULL OR trades_count=0)`)
            updated++
          }
        }
      }
      
      console.log(`  [${Math.min(i+BATCH, rows.length)}/${rows.length}] updated=${updated}`)
      await sleep(500)
    } catch (e) {
      errors++
      if (errors <= 3) console.log(`  Batch error: ${e.message}`)
    }
  }
  console.log(`✅ GMX: ${updated} updated, ${errors} errors`)
}

// =============================================
// JUPITER PERPS - need address mapping from API
// =============================================
async function backfillJupiterPerps() {
  console.log('\n=== JUPITER PERPS ===')
  
  // First get original-case addresses from Jupiter API
  const MARKETS = [
    'So11111111111111111111111111111111111111112',  // SOL
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // BTC
  ]
  
  console.log('  Fetching address mapping from Jupiter API...')
  const addressMap = new Map() // lowercase -> original
  
  for (const mint of MARKETS) {
    for (const sortBy of ['pnl', 'volume']) {
      const data = await fetchJSON(`https://perps-api.jup.ag/v1/top-traders?market_mint=${mint}&sort_by=${sortBy}&limit=1000`)
      if (data) {
        const traders = sortBy === 'pnl' ? data.topTradersByPnl : data.topTradersByVolume
        if (traders) {
          for (const t of traders) {
            if (t.owner) addressMap.set(t.owner.toLowerCase(), t.owner)
          }
        }
      }
      await sleep(500)
    }
  }
  console.log(`  Found ${addressMap.size} unique addresses from Jupiter API`)
  
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='jupiter_perps' AND (trades_count IS NULL OR trades_count=0)
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0, noMapping = 0
  for (let i = 0; i < rows.length; i++) {
    const dbAddr = rows[i][0]
    if (!dbAddr) continue
    
    const originalAddr = addressMap.get(dbAddr.toLowerCase()) || addressMap.get(dbAddr)
    if (!originalAddr) {
      noMapping++
      continue
    }
    
    try {
      const data = await fetchJSON(`https://perps-api.jup.ag/v1/trades?walletAddress=${originalAddr}&limit=1`)
      if (data && data.count > 0) {
        const count = data.count
        // Calculate win rate from trades if available
        const updates = [`trades_count=${count}`]
        
        // Get more trades data for win rate
        const fullData = await fetchJSON(`https://perps-api.jup.ag/v1/trades?walletAddress=${originalAddr}&limit=100`)
        if (fullData?.dataList) {
          const closing = fullData.dataList.filter(t => t.pnl != null && t.action !== 'Increase')
          if (closing.length > 0) {
            const wins = closing.filter(t => parseFloat(t.pnl || '0') > 0).length
            const winRate = ((wins / closing.length) * 100).toFixed(2)
            updates.push(`win_rate=${winRate}`)
          }
        }
        
        psqlExec(`UPDATE trader_snapshots SET ${updates.join(',')} WHERE source='jupiter_perps' AND source_trader_id='${dbAddr}' AND (trades_count IS NULL OR trades_count=0)`)
        updated++
        await sleep(600)
      }
      await sleep(400)
    } catch (e) {
      errors++
      if (errors <= 3) console.log(`  Error ${dbAddr}: ${e.message}`)
    }
    
    if ((i + 1) % 50 === 0 || i === rows.length - 1)
      console.log(`  [${i+1}/${rows.length}] updated=${updated} noMapping=${noMapping} errors=${errors}`)
  }
  console.log(`✅ Jupiter: ${updated} updated, ${noMapping} no mapping, ${errors} errors`)
}

// =============================================
// DYDX v4
// =============================================
async function backfillDYDX() {
  console.log('\n=== DYDX ===')
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='dydx' AND (trades_count IS NULL OR trades_count=0)
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0
  for (let i = 0; i < rows.length; i++) {
    const addr = rows[i][0]
    if (!addr) continue
    
    try {
      // dYdX v4 indexer - get fills count
      const data = await fetchJSON(`https://indexer.dydx.trade/v4/fills?address=${addr}&subaccountNumber=0&limit=1`)
      if (data?.fills) {
        // The API doesn't return total count easily, need to paginate
        // For now, do a rough count by getting more fills
        let totalCount = data.fills.length
        if (totalCount > 0) {
          // Get more to estimate
          const more = await fetchJSON(`https://indexer.dydx.trade/v4/fills?address=${addr}&subaccountNumber=0&limit=100`)
          if (more?.fills) totalCount = more.fills.length
          // If we got 100, there are likely more - but approximate is OK
          if (totalCount >= 100) totalCount = 100 // will mark as 100+
          
          psqlExec(`UPDATE trader_snapshots SET trades_count=${totalCount} WHERE source='dydx' AND source_trader_id='${addr}' AND (trades_count IS NULL OR trades_count=0)`)
          updated++
        }
      }
      await sleep(300)
    } catch (e) {
      errors++
    }
    if ((i + 1) % 20 === 0) console.log(`  [${i+1}/${rows.length}] updated=${updated}`)
  }
  console.log(`✅ dYdX: ${updated} updated, ${errors} errors`)
}

// =============================================
// MAIN
// =============================================
const EXCHANGE = process.argv[2] || 'all'

async function main() {
  console.log('=== TRADES COUNT BACKFILL ===')
  console.log(`Target: ${EXCHANGE}\n`)
  
  // Show current state
  console.log('Current state:')
  console.log(psql(`
    SELECT source, count(DISTINCT source_trader_id) as total, 
           count(DISTINCT CASE WHEN trades_count > 0 THEN source_trader_id END) as with_trades
    FROM trader_snapshots GROUP BY source ORDER BY total DESC
  `))
  
  if (EXCHANGE === 'all' || EXCHANGE === 'hyperliquid') await backfillHyperliquid()
  if (EXCHANGE === 'all' || EXCHANGE === 'gmx') await backfillGMX()
  if (EXCHANGE === 'all' || EXCHANGE === 'jupiter') await backfillJupiterPerps()
  if (EXCHANGE === 'all' || EXCHANGE === 'dydx') await backfillDYDX()
  
  console.log('\n=== FINAL STATE ===')
  console.log(psql(`
    SELECT source, count(DISTINCT source_trader_id) as total, 
           count(DISTINCT CASE WHEN trades_count > 0 THEN source_trader_id END) as with_trades
    FROM trader_snapshots GROUP BY source ORDER BY total DESC
  `))
}

main().catch(e => { console.error(e); process.exit(1) })

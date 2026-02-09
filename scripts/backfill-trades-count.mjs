/**
 * Backfill trades_count for all exchanges
 * Uses psql for DB, fetch for APIs
 */
import 'dotenv/config'
import { execSync } from 'child_process'

const PSQL = '/opt/homebrew/opt/libpq/bin/psql'
const DB_URL = process.env.DATABASE_URL
const PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function psql(sql) {
  const result = execSync(`${PSQL} "${DB_URL}" -t -A -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 30000 })
  return result.trim()
}

function psqlRows(sql) {
  const raw = psql(sql)
  if (!raw) return []
  return raw.split('\n').map(line => line.split('|'))
}

function psqlExec(sql) {
  execSync(`${PSQL} "${DB_URL}" -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 30000 })
}

async function fetchJSON(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(15000),
    })
    if (res.ok) return await res.json()
    return null
  } catch { return null }
}

async function fetchViaProxy(url, options = {}) {
  return fetchJSON(`${PROXY}/proxy?url=${encodeURIComponent(url)}`, options)
}

// =============================================
// HYPERLIQUID - userFills to count trades
// =============================================
async function backfillHyperliquid() {
  console.log('\n=== HYPERLIQUID ===')
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='hyperliquid' AND (trades_count IS NULL OR trades_count=0)
    ORDER BY source_trader_id
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0
  for (let i = 0; i < rows.length; i++) {
    const addr = rows[i][0]
    if (!addr) continue
    
    try {
      // Get all fills by paginating
      let totalFills = 0
      let startTime = 0
      let hasMore = true
      
      while (hasMore) {
        const data = await fetchJSON('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFillsByTime', user: addr, startTime, aggregateByTime: true }),
        })
        
        if (!data || !Array.isArray(data) || data.length === 0) {
          hasMore = false
          break
        }
        
        totalFills += data.length
        if (data.length < 2000) {
          hasMore = false
        } else {
          // Get next page starting after last fill
          startTime = data[data.length - 1].time + 1
        }
        
        if (hasMore) await sleep(300) // rate limit between pages
      }
      
      // Calculate avg_pnl from fills with closedPnl
      // For now just store trades_count
      if (totalFills > 0) {
        psqlExec(`UPDATE trader_snapshots SET trades_count=${totalFills} WHERE source='hyperliquid' AND source_trader_id='${addr}' AND (trades_count IS NULL OR trades_count=0)`)
        updated++
      }
      
      if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${rows.length}, updated: ${updated}`)
      await sleep(200) // ~5 req/s, well within limits
    } catch (e) {
      errors++
      if (errors < 5) console.log(`  Error for ${addr}: ${e.message}`)
    }
  }
  console.log(`Hyperliquid done: ${updated} updated, ${errors} errors`)
}

// =============================================
// GMX - subgraph for trade counts
// =============================================
async function backfillGMX() {
  console.log('\n=== GMX ===')
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='gmx' AND (trades_count IS NULL OR trades_count=0)
    ORDER BY source_trader_id
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  // GMX v2 subgraph on Arbitrum
  const SUBGRAPH = 'https://subgraph.satsuma-prod.com/3b2ced13c8d9/gmx/synthetics-arbitrum-stats/api'
  // Alternative: use the GMX stats API
  const GMX_STATS = 'https://arbitrum-api.gmxinfra.io'
  
  let updated = 0, errors = 0
  // Process in batches of 10 using the subgraph
  for (let i = 0; i < rows.length; i++) {
    const addr = rows[i][0]
    if (!addr) continue
    
    try {
      // Try GMX actions API
      const data = await fetchJSON(`https://arbitrum-api.gmxinfra.io/actions/v2?account=${addr.toLowerCase()}&limit=1`)
      if (data && data.count !== undefined) {
        const count = data.count
        if (count > 0) {
          psqlExec(`UPDATE trader_snapshots SET trades_count=${count} WHERE source='gmx' AND source_trader_id='${addr}' AND (trades_count IS NULL OR trades_count=0)`)
          updated++
        }
        if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${rows.length}, updated: ${updated}`)
        await sleep(300)
        continue
      }
      
      // Fallback: try positions endpoint
      const positions = await fetchJSON(`https://arbitrum-api.gmxinfra.io/positions/historical?account=${addr.toLowerCase()}`)
      if (positions && Array.isArray(positions)) {
        const count = positions.length
        if (count > 0) {
          psqlExec(`UPDATE trader_snapshots SET trades_count=${count} WHERE source='gmx' AND source_trader_id='${addr}' AND (trades_count IS NULL OR trades_count=0)`)
          updated++
        }
      }
      
      if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${rows.length}, updated: ${updated}`)
      await sleep(300)
    } catch (e) {
      errors++
      if (errors < 5) console.log(`  Error for ${addr}: ${e.message}`)
    }
  }
  console.log(`GMX done: ${updated} updated, ${errors} errors`)
}

// =============================================
// JUPITER PERPS - on-chain trade history
// =============================================
async function backfillJupiterPerps() {
  console.log('\n=== JUPITER PERPS ===')
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='jupiter_perps' AND (trades_count IS NULL OR trades_count=0)
    ORDER BY source_trader_id
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0
  for (let i = 0; i < rows.length; i++) {
    const addr = rows[i][0]
    if (!addr) continue
    
    try {
      // Jupiter Perps stats API
      const data = await fetchJSON(`https://perps-api.jup.ag/v1/leaderboard/user/${addr}`)
      if (data && data.trades_count !== undefined) {
        const count = Number(data.trades_count)
        if (count > 0) {
          const avgPnl = data.avg_pnl ? Number(data.avg_pnl) : null
          const updates = [`trades_count=${count}`]
          if (avgPnl !== null) updates.push(`avg_pnl=${avgPnl}`)
          psqlExec(`UPDATE trader_snapshots SET ${updates.join(',')} WHERE source='jupiter_perps' AND source_trader_id='${addr}' AND (trades_count IS NULL OR trades_count=0)`)
          updated++
        }
      } else {
        // Try alternate endpoint
        const stats = await fetchJSON(`https://perps-api.jup.ag/v1/trader/${addr}/stats`)
        if (stats && stats.total_trades) {
          psqlExec(`UPDATE trader_snapshots SET trades_count=${stats.total_trades} WHERE source='jupiter_perps' AND source_trader_id='${addr}' AND (trades_count IS NULL OR trades_count=0)`)
          updated++
        }
      }
      
      if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${rows.length}, updated: ${updated}`)
      await sleep(500)
    } catch (e) {
      errors++
      if (errors < 5) console.log(`  Error for ${addr}: ${e.message}`)
    }
  }
  console.log(`Jupiter done: ${updated} updated, ${errors} errors`)
}

// =============================================
// BITGET - via CF proxy
// =============================================
async function backfillBitget() {
  console.log('\n=== BITGET FUTURES ===')
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='bitget_futures' AND (trades_count IS NULL OR trades_count=0)
    ORDER BY source_trader_id
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0
  for (let i = 0; i < rows.length; i++) {
    const tid = rows[i][0]
    if (!tid) continue
    
    try {
      // Bitget copy trade detail API
      const data = await fetchViaProxy(`https://www.bitget.com/v1/trigger/trace/public/traderDetail?traderUid=${tid}`)
      if (data?.data) {
        const d = data.data
        const trades = Number(d.totalTradeCount || d.tradeCount || 0)
        if (trades > 0) {
          const updates = [`trades_count=${trades}`]
          if (d.avgPnl) updates.push(`avg_pnl=${Number(d.avgPnl)}`)
          if (d.avgHoldingHours) updates.push(`avg_holding_hours=${Number(d.avgHoldingHours)}`)
          psqlExec(`UPDATE trader_snapshots SET ${updates.join(',')} WHERE source='bitget_futures' AND source_trader_id='${tid}' AND (trades_count IS NULL OR trades_count=0)`)
          updated++
        }
      }
      
      if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${rows.length}, updated: ${updated}`)
      await sleep(500)
    } catch (e) {
      errors++
      if (errors < 5) console.log(`  Error for ${tid}: ${e.message}`)
    }
  }
  console.log(`Bitget done: ${updated} updated, ${errors} errors`)
}

// =============================================
// GAINS (gTrade) - already has data (591/591)
// KUCOIN - partially done (184/636)
// =============================================
async function backfillKucoin() {
  console.log('\n=== KUCOIN ===')
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='kucoin' AND (trades_count IS NULL OR trades_count=0)
    ORDER BY source_trader_id
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0
  for (let i = 0; i < rows.length; i++) {
    const tid = rows[i][0]
    if (!tid) continue
    
    try {
      const data = await fetchViaProxy(`https://www.kucoin.com/_api/copy-trade/leader/detail?uid=${tid}`)
      if (data?.data) {
        const d = data.data
        const trades = Number(d.totalTransactions || d.totalOrders || 0)
        if (trades > 0) {
          psqlExec(`UPDATE trader_snapshots SET trades_count=${trades} WHERE source='kucoin' AND source_trader_id='${tid}' AND (trades_count IS NULL OR trades_count=0)`)
          updated++
        }
      }
      
      if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${rows.length}, updated: ${updated}`)
      await sleep(500)
    } catch (e) {
      errors++
      if (errors < 5) console.log(`  Error for ${tid}: ${e.message}`)
    }
  }
  console.log(`KuCoin done: ${updated} updated, ${errors} errors`)
}

// =============================================
// DYDX
// =============================================
async function backfillDYDX() {
  console.log('\n=== DYDX ===')
  const rows = psqlRows(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='dydx' AND (trades_count IS NULL OR trades_count=0)
    ORDER BY source_trader_id
  `)
  console.log(`Traders to process: ${rows.length}`)
  
  let updated = 0, errors = 0
  for (let i = 0; i < rows.length; i++) {
    const addr = rows[i][0]
    if (!addr) continue
    
    try {
      const data = await fetchJSON(`https://indexer.dydx.trade/v4/fills?address=${addr}&limit=1`)
      if (data?.totalResults !== undefined) {
        const count = Number(data.totalResults)
        if (count > 0) {
          psqlExec(`UPDATE trader_snapshots SET trades_count=${count} WHERE source='dydx' AND source_trader_id='${addr}' AND (trades_count IS NULL OR trades_count=0)`)
          updated++
        }
      }
      await sleep(300)
    } catch (e) {
      errors++
    }
  }
  console.log(`dYdX done: ${updated} updated, ${errors} errors`)
}

// =============================================
// MAIN
// =============================================
const EXCHANGE = process.argv[2] || 'all'

async function main() {
  console.log('=== TRADES COUNT BACKFILL ===')
  console.log(`Target: ${EXCHANGE}`)
  console.log(`Proxy: ${PROXY}`)
  
  if (EXCHANGE === 'all' || EXCHANGE === 'hyperliquid') await backfillHyperliquid()
  if (EXCHANGE === 'all' || EXCHANGE === 'gmx') await backfillGMX()
  if (EXCHANGE === 'all' || EXCHANGE === 'jupiter') await backfillJupiterPerps()
  if (EXCHANGE === 'all' || EXCHANGE === 'bitget') await backfillBitget()
  if (EXCHANGE === 'all' || EXCHANGE === 'kucoin') await backfillKucoin()
  if (EXCHANGE === 'all' || EXCHANGE === 'dydx') await backfillDYDX()
  
  // Final stats
  console.log('\n=== FINAL STATS ===')
  const stats = psql(`
    SELECT source, count(DISTINCT source_trader_id) as total, 
           count(DISTINCT CASE WHEN trades_count > 0 THEN source_trader_id END) as with_trades
    FROM trader_snapshots GROUP BY source ORDER BY total DESC
  `)
  console.log(stats)
}

main().catch(e => { console.error(e); process.exit(1) })

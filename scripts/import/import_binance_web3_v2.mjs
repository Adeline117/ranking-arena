/**
 * Binance Web3 排行榜 - 纯API版本
 *
 * 用法: node scripts/import/import_binance_web3_v2.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'binance_web3'

const PERIOD_MAP = { '7D': '7d', '30D': '30d', '90D': '90d' }
const CHAINS = [
  { chainId: 56, name: 'BSC' },
  { chainId: 1, name: 'ETH' },
  { chainId: 8453, name: 'Base' },
]
const PAGE_SIZE = 100

async function fetchPage(period, chainId, pageNo) {
  const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=${pageNo}&pageSize=${PAGE_SIZE}&sortBy=0&orderBy=0&period=${period}&chainId=${chainId}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json?.data?.data || []
}

async function fetchAllTraders(periodApi, chainId, chainName) {
  const all = []
  let pageNo = 1
  while (true) {
    const items = await fetchPage(periodApi, chainId, pageNo)
    if (!items.length) break
    all.push(...items)
    console.log(`    ${chainName} page ${pageNo}: ${items.length} traders`)
    if (items.length < PAGE_SIZE) break
    pageNo++
    await sleep(300)
  }
  return all
}

async function importPeriod(period) {
  const periodApi = PERIOD_MAP[period]
  console.log(`\n=== Binance Web3 ${period} (${periodApi}) ===`)

  // Dedupe by address across chains, BSC first (priority)
  const tradersMap = new Map()

  for (const { chainId, name } of CHAINS) {
    const items = await fetchAllTraders(periodApi, chainId, name)
    for (const t of items) {
      if (!tradersMap.has(t.address)) {
        tradersMap.set(t.address, t)
      }
    }
    await sleep(500)
  }

  const traders = [...tradersMap.values()]
  console.log(`  Total unique traders: ${traders.length}`)
  if (!traders.length) return 0

  const now = new Date().toISOString()

  // Upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_trader_id: t.address,
    handle: t.addressLabel || t.address.slice(0, 10),
    avatar_url: t.addressLogo || null,
    last_refreshed_at: now,
  }))

  for (let i = 0; i < sourcesData.length; i += 100) {
    const batch = sourcesData.slice(i, i + 100)
    const { error } = await supabase
      .from('trader_sources')
      .upsert(batch, { onConflict: 'source,source_trader_id' })
    if (error) console.log(`  ⚠️ sources upsert error: ${error.message}`)
  }

  // Upsert trader_snapshots
  const snapshotsData = traders.map((t, idx) => {
    const roi = (t.realizedPnlPercent || 0) * 100
    const pnl = t.realizedPnl || null
    const winRate = t.winRate != null ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate) : null
    const tradesCount = t.totalTxCnt != null ? parseInt(t.totalTxCnt) : null
    return {
      source: SOURCE,
      source_trader_id: t.address,
      season_id: period,
      rank: idx + 1,
      roi,
      pnl,
      win_rate: winRate,
      trades_count: tradesCount,
      arena_score: calculateArenaScore(roi, pnl, null, winRate, period)?.totalScore || 0,
      captured_at: now,
    }
  })

  for (let i = 0; i < snapshotsData.length; i += 100) {
    const batch = snapshotsData.slice(i, i + 100)
    const { error } = await supabase
      .from('trader_snapshots')
      .upsert(batch, { onConflict: 'source,source_trader_id,season_id' })
    if (error) console.log(`  ⚠️ snapshots upsert error: ${error.message}`)
  }

  console.log(`  ✅ Saved ${traders.length} traders for ${period}`)
  return traders.length
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('Binance Web3 Import v2 (Pure API)')
  console.log('Periods:', periods.join(', '))

  let total = 0
  for (const p of periods) {
    total += await importPeriod(p)
    await sleep(1000)
  }

  console.log(`\n🎉 Done. Total: ${total} trader-period records`)
}

main().catch(e => { console.error(e); process.exit(1) })

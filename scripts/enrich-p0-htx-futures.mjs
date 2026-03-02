#!/usr/bin/env node
/**
 * HTX Futures P0 Enrichment
 * 
 * Priority fields: win_rate, max_drawdown, avatar_url
 * Note: trades_count NOT available from ranking API
 * 
 * Usage: node scripts/enrich-p0-htx-futures.mjs [--dry-run]
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE = 'htx_futures'
const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace('%', '').trim())
  return isNaN(n) ? null : n
}

async function fetchRankingPage(pageNo, pageSize = 50) {
  const url = `${API_URL}?rankType=1&pageNo=${pageNo}&pageSize=${pageSize}`
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': 'https://futures.htx.com',
      'Accept': 'application/json',
    }
  })
  
  if (!response.ok) return null
  const json = await response.json()
  if (json.code !== 200) return null
  return json.data || null
}

async function main() {
  console.log(`\n🚀 HTX Futures P0 Enrichment (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN]\n')

  // Get rows needing enrichment
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown, avatar_url, roi, pnl')
    .eq('source', SOURCE)
    .or('max_drawdown.is.null,win_rate.is.null,avatar_url.is.null')
    .limit(1000)

  if (error) { console.error('Query error:', error.message); process.exit(1) }
  console.log(`  DB rows needing enrichment: ${rows.length}`)
  if (rows.length === 0) {
    console.log('  ✅ All rows complete!')
    return
  }

  // Build map of needed traders
  const needMap = new Map()
  for (const row of rows) {
    const sign = row.source_trader_id.replace(/=+$/, '') // Strip trailing =
    needMap.set(sign, row)
  }

  console.log(`  Unique traders needed: ${needMap.size}`)
  console.log('\n📊 Fetching HTX ranking pages...')

  // Fetch all ranking pages (typically ~10 pages with pageSize=50)
  const allTraders = []
  let pageNo = 1
  let hasMore = true

  while (hasMore && pageNo <= 50) {
    const data = await fetchRankingPage(pageNo, 50)
    if (!data || !data.itemList || data.itemList.length === 0) {
      console.log(`  Page ${pageNo}: no data, stopping`)
      hasMore = false
      break
    }

    const items = data.itemList
    console.log(`  Page ${pageNo}: ${items.length} traders`)
    allTraders.push(...items)

    // Check if we have more pages
    if (data.totalPage && pageNo >= data.totalPage) {
      hasMore = false
    }
    if (items.length < 50) {
      hasMore = false // Last page
    }

    pageNo++
    await sleep(300)
  }

  console.log(`  Total traders fetched: ${allTraders.length}`)

  // Build trader map by userSign
  const traderMap = new Map()
  for (const item of allTraders) {
    const sign = (item.userSign || '').replace(/=+$/, '')
    if (!sign) continue
    traderMap.set(sign, item)
  }

  console.log(`  Unique traders in map: ${traderMap.size}`)

  // Match and update
  console.log('\n📊 Matching traders...')
  let matched = 0, unmatched = 0, updated = 0, skipped = 0, errors = 0

  for (const [sign, row] of needMap) {
    const trader = traderMap.get(sign)
    if (!trader) {
      console.log(`  ✗ ${row.handle} (${sign}) - not found`)
      unmatched++
      continue
    }

    matched++
    const updates = {}

    // CRITICAL: Only use real API data
    if (row.win_rate == null && trader.winRate != null) {
      let wr = parseNum(trader.winRate)
      // HTX returns decimal (0.685) → convert to %
      if (wr != null && wr > 0 && wr <= 1) wr = wr * 100
      if (wr != null && wr >= 0 && wr <= 100) updates.win_rate = wr
    }

    if (row.max_drawdown == null && trader.mdd != null) {
      let mdd = parseNum(trader.mdd)
      if (mdd != null) {
        if (mdd < 0) mdd = Math.abs(mdd) // Store as positive
        if (mdd > 100) mdd = null // Invalid
        if (mdd != null) updates.max_drawdown = mdd
      }
    }

    if (!row.avatar_url && trader.imgUrl) {
      updates.avatar_url = trader.imgUrl
    }

    // Optional: update ROI/PNL if available
    if (row.roi == null && trader.roi != null) {
      const roi = parseNum(trader.roi)
      if (roi != null) updates.roi = roi
    }

    if (row.pnl == null && trader.pnl != null) {
      const pnl = parseNum(trader.pnl)
      if (pnl != null) updates.pnl = pnl
    }

    if (Object.keys(updates).length === 0) {
      console.log(`  - ${row.handle} - no updates needed`)
      skipped++
      continue
    }

    if (DRY_RUN) {
      console.log(`  [DRY] ${row.handle}: ${JSON.stringify(updates)}`)
      updated++
      continue
    }

    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) {
      updated++
      console.log(`  ✓ ${row.handle}: ${Object.keys(updates).join(', ')}`)
    } else {
      errors++
      console.error(`  Error updating ${row.handle}: ${ue.message}`)
    }
  }

  console.log(`\n✅ Complete: ${updated} updated, ${skipped} skipped, ${matched} matched, ${unmatched} unmatched, ${errors} errors`)

  // Final stats
  const { count: mddNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  const { count: wrNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('win_rate', null)

  const { count: avatarNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('avatar_url', null)

  console.log(`\n📊 Final nulls: WR=${wrNull} MDD=${mddNull} Avatar=${avatarNull}`)
  console.log('  ⚠️ trades_count NOT available from HTX ranking API')
}

main().catch(e => { console.error(e); process.exit(1) })

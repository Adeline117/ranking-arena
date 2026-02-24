/**
 * fix_binance_web3_nulls.mjs
 *
 * Fix NULL win_rate, max_drawdown in leaderboard_ranks and avatar_url in trader_sources
 * for the binance_web3 source.
 *
 * Strategy:
 *  1. Fetch all leaderboard pages for all chains & periods to build a full address→data map.
 *     Each entry has: winRate, addressLogo, dailyPNL, realizedPnl, realizedPnlPercent.
 *  2. Fix leaderboard_ranks.win_rate:
 *     a. Truncated address rows (0x7f25...4d6b): match to full-address row in the same table,
 *        copy win_rate and max_drawdown from that row.
 *     b. Full-address rows with null win_rate: look up in API map.
 *  3. Fix leaderboard_ranks.max_drawdown (full-address rows):
 *     Compute from dailyPNL data returned by the API.
 *     Formula: initialCapital = totalRealizedPnl / totalRoiRatio, then track
 *     cumulative portfolio value each day and compute peak-to-trough drawdown.
 *  4. Fix trader_sources.avatar_url (null rows):
 *     a. Full addresses: use addressLogo from API map.
 *     b. Truncated addresses: match by prefix+suffix to a full address in the API map.
 *  5. Update trader_snapshots with same win_rate / max_drawdown fixes (keeps data consistent
 *     so the next leaderboard recompute doesn't overwrite the fixes).
 *
 * HARD RULES:
 *  - Only real API values or values derived from real API data (no fabrication).
 *  - If a trader is not found in the current leaderboard, skip (document count).
 *  - Never overwrite existing non-null values.
 *  - Do NOT touch any UI/Next.js files.
 *
 * Usage:
 *   node scripts/import/fix_binance_web3_nulls.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const SOURCE = 'binance_web3'
const CHAINS = [
  { chainId: 56, name: 'BSC' },
  { chainId: 1, name: 'ETH' },
  { chainId: 8453, name: 'Base' },
]
const PERIODS = [
  { api: '7d', season: '7D' },
  { api: '30d', season: '30D' },
  { api: '90d', season: '90D' },
]
const PAGE_SIZE = 100

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── API helpers ────────────────────────────────────────────────────────────

async function fetchPage(period, chainId, pageNo) {
  const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=${pageNo}&pageSize=${PAGE_SIZE}&sortBy=0&orderBy=0&period=${period}&chainId=${chainId}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const json = await res.json()
  return json?.data?.data || []
}

async function fetchAllLeaderboardData() {
  console.log('\n📡 Fetching all leaderboard data from Binance Web3 API...')
  // addrMap: address (lowercase) → best entry per period
  // We store per-period data so we can match season-specific records
  // periodMap: periodKey (e.g. "7d") → Map(address → apiEntry)
  const periodMaps = {}
  for (const { api } of PERIODS) {
    periodMaps[api] = new Map()
  }
  // Also a global map for avatars (use first occurrence)
  const globalAvatarMap = new Map()

  for (const { api: periodApi, season } of PERIODS) {
    console.log(`\n  Period: ${season}`)
    for (const { chainId, name } of CHAINS) {
      let pageNo = 1
      while (true) {
        try {
          const items = await fetchPage(periodApi, chainId, pageNo)
          if (!items.length) break
          for (const t of items) {
            const addr = t.address?.toLowerCase()
            if (!addr) continue
            // Store per-period data (first occurrence = highest rank = best)
            if (!periodMaps[periodApi].has(addr)) {
              periodMaps[periodApi].set(addr, t)
            }
            // Store in global avatar map
            if (!globalAvatarMap.has(addr) && t.addressLogo) {
              globalAvatarMap.set(addr, t.addressLogo)
            }
          }
          console.log(`    ${name} pg${pageNo}: ${items.length} traders (cumulative for ${periodApi}: ${periodMaps[periodApi].size})`)
          if (items.length < PAGE_SIZE) break
          pageNo++
          await sleep(300)
        } catch (e) {
          console.warn(`    ⚠️  Error fetching ${name} pg${pageNo}: ${e.message}`)
          break
        }
      }
      await sleep(400)
    }
  }

  const totalUnique = new Set([
    ...periodMaps['7d'].keys(),
    ...periodMaps['30d'].keys(),
    ...periodMaps['90d'].keys(),
  ]).size
  console.log(`\n  ✅ Total unique addresses across all periods: ${totalUnique}`)
  console.log(`  Global avatar map: ${globalAvatarMap.size} addresses with logos`)
  return { periodMaps, globalAvatarMap }
}

// ─── Max drawdown computation from dailyPNL ─────────────────────────────────

function computeMaxDrawdownFromDailyPnl(apiEntry) {
  const totalPnl = parseFloat(apiEntry.realizedPnl)
  const totalRoi = parseFloat(apiEntry.realizedPnlPercent) // e.g. 0.2947

  if (!isFinite(totalPnl) || !isFinite(totalRoi) || totalRoi <= 0) return null
  if (!apiEntry.dailyPNL || apiEntry.dailyPNL.length === 0) return null

  const initialCapital = totalPnl / totalRoi
  if (initialCapital <= 0 || !isFinite(initialCapital)) return null

  // Sort by date ascending
  const days = [...apiEntry.dailyPNL].sort((a, b) => a.dt.localeCompare(b.dt))

  // Build cumulative portfolio values
  const portfolioValues = [initialCapital]
  let cumPnl = 0
  for (const day of days) {
    cumPnl += parseFloat(day.realizedPnl) || 0
    portfolioValues.push(initialCapital + cumPnl)
  }

  // Compute max drawdown
  let peak = portfolioValues[0]
  let maxDD = 0
  for (const v of portfolioValues) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = (peak - v) / peak * 100
      if (dd > maxDD) maxDD = dd
    }
  }

  const result = Math.round(maxDD * 100) / 100 // round to 2 decimal places

  // Only return meaningful values; if 0% (all profitable days at daily granularity),
  // return null — the arena scorer applies a penalty for null MDD, which is more
  // honest than claiming 0% drawdown when intra-day data isn't available.
  return result > 0.1 ? result : null
}

// ─── Main fix routines ────────────────────────────────────────────────────────

async function fixWinRateTruncated() {
  console.log('\n\n=== Step 1: Fix win_rate for truncated address rows (leaderboard_ranks) ===')

  // Get all LR rows with truncated addresses and null win_rate
  const { data: truncRows, error } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .is('win_rate', null)
    .like('source_trader_id', '%...%')

  if (error) { console.error('  DB error:', error.message); return 0 }
  if (!truncRows?.length) { console.log('  No truncated rows with null win_rate.'); return 0 }
  console.log(`  Found ${truncRows.length} truncated rows with null win_rate.`)

  // For each truncated row, find matching full-address row in leaderboard_ranks
  let updated = 0, noMatch = 0

  for (const row of truncRows) {
    const parts = row.source_trader_id.split('...')
    if (parts.length !== 2) { noMatch++; continue }
    const [prefix, suffix] = parts

    // Find full-address row(s) for the same season that have win_rate
    const { data: fullRows } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, win_rate, max_drawdown')
      .eq('source', SOURCE)
      .eq('season_id', row.season_id)
      .like('source_trader_id', `${prefix}%${suffix}`)
      .not('win_rate', 'is', null)
      .limit(1)

    if (!fullRows?.length) {
      // Try without win_rate filter (maybe full row also has null win_rate but has other data)
      const { data: fullRowsAny } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, win_rate, max_drawdown')
        .eq('source', SOURCE)
        .eq('season_id', row.season_id)
        .like('source_trader_id', `${prefix}%${suffix}`)
        .limit(1)
      if (!fullRowsAny?.length) { noMatch++; continue }
      // Full row found but also has null win_rate - skip
      noMatch++
      continue
    }

    const fullRow = fullRows[0]
    const updates = {}
    if (fullRow.win_rate != null) updates.win_rate = fullRow.win_rate
    if (fullRow.max_drawdown != null && row.max_drawdown == null) {
      updates.max_drawdown = fullRow.max_drawdown
    }

    if (Object.keys(updates).length === 0) { noMatch++; continue }

    const { error: upErr } = await supabase
      .from('leaderboard_ranks')
      .update(updates)
      .eq('id', row.id)

    if (upErr) {
      console.warn(`  ❌ Update error for id=${row.id}: ${upErr.message}`)
      noMatch++
    } else {
      updated++
    }
  }

  console.log(`  ✅ Updated: ${updated}, no match/skip: ${noMatch}`)
  return updated
}

async function fixWinRateFullAddress(periodMaps) {
  console.log('\n=== Step 2: Fix win_rate for full-address rows (leaderboard_ranks) ===')

  const { data: wrNullRows } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id')
    .eq('source', SOURCE)
    .is('win_rate', null)
    .not('source_trader_id', 'like', '%...%')

  if (!wrNullRows?.length) { console.log('  No full-address rows with null win_rate.'); return 0 }
  console.log(`  Found ${wrNullRows.length} full-address rows with null win_rate.`)

  let updated = 0, notFound = 0

  for (const row of wrNullRows) {
    const addr = row.source_trader_id.toLowerCase()
    const periodKey = row.season_id === '7D' ? '7d' : row.season_id === '30D' ? '30d' : '90d'
    const apiEntry = periodMaps[periodKey]?.get(addr)

    if (!apiEntry) { notFound++; continue }
    const wr = apiEntry.winRate != null ? parseFloat(apiEntry.winRate) : null
    if (wr == null) { notFound++; continue }
    const wrPct = wr <= 1 ? wr * 100 : wr

    const { error } = await supabase
      .from('leaderboard_ranks')
      .update({ win_rate: Math.round(wrPct * 100) / 100 })
      .eq('id', row.id)

    if (error) {
      console.warn(`  ❌ ${row.source_trader_id}: ${error.message}`)
      notFound++
    } else {
      updated++
    }
  }

  console.log(`  ✅ Updated: ${updated}, not found in API: ${notFound}`)
  return updated
}

async function fixMaxDrawdown(periodMaps) {
  console.log('\n=== Step 3: Fix max_drawdown for full-address rows (leaderboard_ranks) ===')

  // Get all MDD null rows with full addresses
  let allMddNull = []
  let page = 0
  while (true) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id')
      .eq('source', SOURCE)
      .is('max_drawdown', null)
      .not('source_trader_id', 'like', '%...%')
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (error || !data?.length) break
    allMddNull = allMddNull.concat(data)
    if (data.length < 1000) break
    page++
  }

  console.log(`  Found ${allMddNull.length} full-address rows with null max_drawdown.`)
  if (!allMddNull.length) return 0

  let updated = 0, notFound = 0, cannotCompute = 0

  // Process in batches to avoid overwhelming DB
  const BATCH = 50
  for (let i = 0; i < allMddNull.length; i += BATCH) {
    const batch = allMddNull.slice(i, i + BATCH)
    const promises = []

    for (const row of batch) {
      const addr = row.source_trader_id.toLowerCase()
      const periodKey = row.season_id === '7D' ? '7d' : row.season_id === '30D' ? '30d' : '90d'
      const apiEntry = periodMaps[periodKey]?.get(addr)

      if (!apiEntry) { notFound++; continue }

      const mdd = computeMaxDrawdownFromDailyPnl(apiEntry)
      if (mdd === null) { cannotCompute++; continue }

      promises.push(
        supabase
          .from('leaderboard_ranks')
          .update({ max_drawdown: mdd })
          .eq('id', row.id)
          .then(({ error }) => {
            if (error) console.warn(`  ❌ id=${row.id}: ${error.message}`)
            else updated++
          })
      )
    }

    if (promises.length) await Promise.all(promises)

    if ((i + BATCH) % 200 === 0 || i + BATCH >= allMddNull.length) {
      console.log(`  Progress: ${Math.min(i + BATCH, allMddNull.length)}/${allMddNull.length} — updated: ${updated}`)
    }
  }

  console.log(`  ✅ Updated: ${updated}, not in API: ${notFound}, cannot compute: ${cannotCompute}`)
  return updated
}

async function fixAvatarUrls(periodMaps, globalAvatarMap) {
  console.log('\n=== Step 4: Fix avatar_url in trader_sources ===')

  // Get all avatar_url null rows
  let allAvNull = []
  let page = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', SOURCE)
      .is('avatar_url', null)
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (error || !data?.length) break
    allAvNull = allAvNull.concat(data)
    if (data.length < 1000) break
    page++
  }

  console.log(`  Found ${allAvNull.length} rows with null avatar_url.`)

  const fullRows = allAvNull.filter(r => !r.source_trader_id.includes('...'))
  const truncRows = allAvNull.filter(r => r.source_trader_id.includes('...'))
  console.log(`  Full addresses: ${fullRows.length}, truncated: ${truncRows.length}`)

  let updated = 0, notFound = 0

  // Fix full addresses using global avatar map
  const BATCH = 100
  for (let i = 0; i < fullRows.length; i += BATCH) {
    const batch = fullRows.slice(i, i + BATCH)
    const promises = []

    for (const row of batch) {
      const addr = row.source_trader_id.toLowerCase()
      const logo = globalAvatarMap.get(addr)

      if (!logo) {
        // Also try searching across all periodMaps
        let found = null
        for (const pmap of Object.values(periodMaps)) {
          const entry = pmap.get(addr)
          if (entry?.addressLogo) { found = entry.addressLogo; break }
        }
        if (!found) { notFound++; continue }
        globalAvatarMap.set(addr, found) // cache
        promises.push(
          supabase
            .from('trader_sources')
            .update({ avatar_url: found })
            .eq('id', row.id)
            .is('avatar_url', null)
            .then(({ error }) => { if (!error) updated++ })
        )
      } else {
        promises.push(
          supabase
            .from('trader_sources')
            .update({ avatar_url: logo })
            .eq('id', row.id)
            .is('avatar_url', null)
            .then(({ error }) => { if (!error) updated++ })
        )
      }
    }

    if (promises.length) await Promise.all(promises)

    if ((i + BATCH) % 500 === 0 || i + BATCH >= fullRows.length) {
      console.log(`  Full addr progress: ${Math.min(i + BATCH, fullRows.length)}/${fullRows.length} — updated: ${updated}`)
    }
  }

  // Fix truncated addresses by matching prefix+suffix against global avatar map
  let truncUpdated = 0
  for (const row of truncRows) {
    const parts = row.source_trader_id.split('...')
    if (parts.length !== 2) { notFound++; continue }
    const [prefix, suffix] = parts

    let matchedLogo = null
    for (const [fullAddr, logo] of globalAvatarMap.entries()) {
      if (
        fullAddr.startsWith(prefix.toLowerCase()) &&
        fullAddr.endsWith(suffix.toLowerCase()) &&
        logo
      ) {
        matchedLogo = logo
        break
      }
    }

    if (!matchedLogo) { notFound++; continue }

    const { error } = await supabase
      .from('trader_sources')
      .update({ avatar_url: matchedLogo })
      .eq('id', row.id)
      .is('avatar_url', null)

    if (!error) { updated++; truncUpdated++ }
  }

  console.log(`  ✅ Updated: ${updated} (full: ${updated - truncUpdated}, trunc: ${truncUpdated}), not found: ${notFound}`)
  return updated
}

async function fixTraderSnapshotsWinRate(periodMaps) {
  console.log('\n=== Step 5: Sync win_rate to trader_snapshots (for leaderboard recompute consistency) ===')

  // Get all snapshots with null win_rate for binance_web3
  let allWrNull = []
  let page = 0
  while (true) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, season_id')
      .eq('source', SOURCE)
      .is('win_rate', null)
      .not('source_trader_id', 'like', '%...%')
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (!data?.length) break
    allWrNull = allWrNull.concat(data)
    if (data.length < 1000) break
    page++
  }

  console.log(`  Found ${allWrNull.length} full-addr snapshot rows with null win_rate.`)
  if (!allWrNull.length) return 0

  let updated = 0, notFound = 0
  const BATCH = 100
  for (let i = 0; i < allWrNull.length; i += BATCH) {
    const batch = allWrNull.slice(i, i + BATCH)
    const promises = []
    for (const row of batch) {
      const addr = row.source_trader_id.toLowerCase()
      const periodKey = row.season_id === '7D' ? '7d' : row.season_id === '30D' ? '30d' : '90d'
      const entry = periodMaps[periodKey]?.get(addr)
      if (!entry || entry.winRate == null) { notFound++; continue }
      const wr = parseFloat(entry.winRate)
      const wrPct = wr <= 1 ? wr * 100 : wr
      promises.push(
        supabase
          .from('trader_snapshots')
          .update({ win_rate: Math.round(wrPct * 100) / 100 })
          .eq('id', row.id)
          .then(({ error }) => { if (!error) updated++ })
      )
    }
    if (promises.length) await Promise.all(promises)
  }
  console.log(`  ✅ Snapshots win_rate updated: ${updated}, not found: ${notFound}`)
  return updated
}

async function fixTraderSnapshotsMdd(periodMaps) {
  console.log('\n=== Step 6: Sync max_drawdown to trader_snapshots ===')

  let allMddNull = []
  let page = 0
  while (true) {
    const { data } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, season_id')
      .eq('source', SOURCE)
      .is('max_drawdown', null)
      .not('source_trader_id', 'like', '%...%')
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (!data?.length) break
    allMddNull = allMddNull.concat(data)
    if (data.length < 1000) break
    page++
  }

  console.log(`  Found ${allMddNull.length} full-addr snapshot rows with null max_drawdown.`)
  if (!allMddNull.length) return 0

  let updated = 0, notFound = 0, cannotCompute = 0
  const BATCH = 100
  for (let i = 0; i < allMddNull.length; i += BATCH) {
    const batch = allMddNull.slice(i, i + BATCH)
    const promises = []
    for (const row of batch) {
      const addr = row.source_trader_id.toLowerCase()
      const periodKey = row.season_id === '7D' ? '7d' : row.season_id === '30D' ? '30d' : '90d'
      const entry = periodMaps[periodKey]?.get(addr)
      if (!entry) { notFound++; continue }
      const mdd = computeMaxDrawdownFromDailyPnl(entry)
      if (mdd === null) { cannotCompute++; continue }
      promises.push(
        supabase
          .from('trader_snapshots')
          .update({ max_drawdown: mdd })
          .eq('id', row.id)
          .then(({ error }) => { if (!error) updated++ })
      )
    }
    if (promises.length) await Promise.all(promises)
    if ((i + BATCH) % 500 === 0 || i + BATCH >= allMddNull.length) {
      console.log(`  Snapshot MDD progress: ${Math.min(i + BATCH, allMddNull.length)}/${allMddNull.length}`)
    }
  }
  console.log(`  ✅ Snapshots max_drawdown updated: ${updated}, not found: ${notFound}, cannot compute: ${cannotCompute}`)
  return updated
}

// ─── Verify ──────────────────────────────────────────────────────────────────

async function verify() {
  console.log('\n\n=== VERIFICATION ===')
  const { count: lrTotal } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: lrWrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: lrMddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: tsTotal } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: tsWrNull } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: tsMddNull } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: avTotal } = await supabase.from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: avNull } = await supabase.from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('avatar_url', null)

  console.log(`leaderboard_ranks: total=${lrTotal} | win_rate_null=${lrWrNull} | max_drawdown_null=${lrMddNull}`)
  console.log(`trader_snapshots:  total=${tsTotal} | win_rate_null=${tsWrNull} | max_drawdown_null=${tsMddNull}`)
  console.log(`trader_sources:    total=${avTotal} | avatar_url_null=${avNull}`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║   Binance Web3 Null-Fix Script                           ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('Time:', new Date().toISOString())

  // PRE-CHECK
  await verify()

  // FETCH API DATA
  const { periodMaps, globalAvatarMap } = await fetchAllLeaderboardData()

  // FIXES
  await fixWinRateTruncated()
  await fixWinRateFullAddress(periodMaps)
  await fixMaxDrawdown(periodMaps)
  await fixAvatarUrls(periodMaps, globalAvatarMap)
  await fixTraderSnapshotsWinRate(periodMaps)
  await fixTraderSnapshotsMdd(periodMaps)

  // POST-CHECK
  console.log('\n')
  await verify()
  console.log('\n🎉 Done!')
}

main().catch(e => { console.error(e); process.exit(1) })

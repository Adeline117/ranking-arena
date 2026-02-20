#!/usr/bin/env node
/**
 * KuCoin Copy Trading → leaderboard_ranks (source='kucoin_spot')
 *
 * API endpoint (no auth needed):
 *   GET https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US
 *   POST body: { "pageNum": 1, "pageSize": 12, "orderBy": "thirtyDayPnlRatio", "orderDirection": "DESC" }
 *   Response: { data: { currentPage, pageSize, totalNum, totalPage, items: [...] } }
 *
 * Trader fields: leadConfigId, nickName, avatarUrl, daysAsLeader, currentCopyUserCount,
 *                thirtyDayPnlRatio, totalPnlRatio, followerPnl, leadPrincipal
 *
 * Usage: node scripts/import-kucoin-spot.mjs [--dry-run] [--period=90D]
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const PERIOD_ARG = process.argv.find(a => a.startsWith('--period='))?.split('=')[1] || '90D'
const SOURCE = 'kucoin_spot'

const API_URL = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query'
const MAX_PAGES = 60
const PAGE_SIZE = 12

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchPage(pageNum) {
  const url = `${API_URL}?lang=en_US`
  // Try POST with JSON body first
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Referer': 'https://www.kucoin.com/copy-trading',
          'Origin': 'https://www.kucoin.com',
        },
        body: JSON.stringify({
          currentPage: pageNum,
          pageSize: PAGE_SIZE,
          orderBy: 'thirtyDayPnlRatio',
          orderDirection: 'DESC',
        }),
        signal: AbortSignal.timeout(20000),
      })
      const json = await res.json()
      if (json?.success && json?.data?.items) return json.data
      if (attempt < 2) { await sleep(2000); continue }
      throw new Error(`API returned: ${JSON.stringify(json).slice(0, 200)}`)
    } catch (e) {
      if (attempt < 2) { await sleep(2000); continue }
      throw e
    }
  }
}

async function main() {
  console.log(`\n🚀 KuCoin Copy Trading Import (source='${SOURCE}', period=${PERIOD_ARG})`)
  if (DRY_RUN) console.log('  [DRY RUN — no DB writes]\n')

  // Check existing in DB
  const { count: existing } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .eq('season_id', PERIOD_ARG)
  console.log(`  Existing leaderboard_ranks (${SOURCE}, ${PERIOD_ARG}): ${existing}`)

  // Fetch page 1 to get total
  console.log('\nFetching page 1...')
  const page1 = await fetchPage(1)
  const totalPages = Math.min(page1.totalPage, MAX_PAGES)
  const totalTraders = page1.totalNum
  console.log(`  Total traders: ${totalTraders}, Pages: ${page1.totalPage} (fetching up to ${totalPages})`)

  // Collect all traders (dedup by leadConfigId)
  const allTraders = []
  const seenIds = new Set()
  const addTraders = (items) => {
    for (const t of items) {
      if (!t.leadConfigId) continue
      if (seenIds.has(t.leadConfigId)) continue
      seenIds.add(t.leadConfigId)
      const roi30d = t.thirtyDayPnlRatio != null ? parseFloat(t.thirtyDayPnlRatio) * 100 : null
      const roiTotal = t.totalPnlRatio != null ? parseFloat(t.totalPnlRatio) * 100 : null
      allTraders.push({
        traderId: String(t.leadConfigId),
        handle: t.nickName || `Trader_${t.leadConfigId}`,
        avatarUrl: t.avatarUrl || null,
        roi: roi30d,
        roiTotal,
        daysAsLeader: t.daysAsLeader || null,
        followers: t.currentCopyUserCount || 0,
        followerPnl: t.followerPnl ? parseFloat(t.followerPnl) : null,
        leadPrincipal: t.leadPrincipal ? parseFloat(t.leadPrincipal) : null,
      })
    }
  }

  addTraders(page1.items)

  for (let p = 2; p <= totalPages; p++) {
    process.stdout.write(`  Page ${p}/${totalPages} (${allTraders.length} collected)...\r`)
    try {
      const pageData = await fetchPage(p)
      addTraders(pageData.items)
    } catch (e) {
      console.log(`\n  ⚠ Error on page ${p}: ${e.message.slice(0, 80)}`)
    }
    await sleep(300)
  }
  console.log(`\n  Total collected: ${allTraders.length} traders`)

  // Sort by roi (desc) and assign ranks
  allTraders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  allTraders.forEach((t, idx) => t.rank = idx + 1)

  console.log('\n📋 Top 10:')
  for (const t of allTraders.slice(0, 10)) {
    console.log(`  #${t.rank} ${t.handle} roi=${t.roi?.toFixed(2)}% followers=${t.followers} daysAsLeader=${t.daysAsLeader}`)
  }

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete — no DB writes.')
    return
  }

  const now = new Date().toISOString()
  let inserted = 0, updated = 0, errors = 0

  console.log(`\nInserting ${allTraders.length} traders into leaderboard_ranks...`)
  for (const t of allTraders) {
    const lr = {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: PERIOD_ARG,
      rank: t.rank,
      handle: t.handle,
      avatar_url: t.avatarUrl,
      roi: t.roi,
      pnl: t.followerPnl,
      win_rate: null,
      followers: t.followers,
      computed_at: now,
    }

    // Also upsert to trader_sources
    try {
      await sb.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: t.traderId,
        handle: t.handle,
        avatar_url: t.avatarUrl,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })
    } catch {}

    const { data: ex } = await sb
      .from('leaderboard_ranks')
      .select('id')
      .eq('source', SOURCE)
      .eq('source_trader_id', t.traderId)
      .eq('season_id', PERIOD_ARG)
      .limit(1)

    if (ex?.length) {
      const { error } = await sb.from('leaderboard_ranks').update({ ...lr, computed_at: now }).eq('id', ex[0].id)
      if (error) { console.error(`  ❌ ${t.handle}: ${error.message}`); errors++ } else updated++
    } else {
      const { error } = await sb.from('leaderboard_ranks').insert({ ...lr, computed_at: now })
      if (error) { console.error(`  ❌ ${t.handle}: ${error.message}`); errors++ } else inserted++
    }
  }

  console.log(`\n✅ Done!`)
  console.log(`  Inserted: ${inserted} | Updated: ${updated} | Errors: ${errors}`)

  const { count } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
  console.log(`\n📊 leaderboard_ranks (${SOURCE}): ${count} total rows`)

  const { data: sample } = await sb
    .from('leaderboard_ranks')
    .select('handle, season_id, rank, roi, followers')
    .eq('source', SOURCE)
    .order('rank')
    .limit(5)
  console.log('\n  Top 5:')
  for (const r of (sample || [])) {
    console.log(`    [${r.season_id}] #${r.rank} ${r.handle} roi=${r.roi?.toFixed(2)}% followers=${r.followers}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

#!/usr/bin/env node
/**
 * OKX Spot Copy Trading Import (v2 - fixed)
 *
 * Uses SSR HTML from en-gb locale which bypasses US geo-restriction.
 * Key fix: do NOT send 'Accept: text/html' header (OKX serves 404 if Accept header present).
 *
 * URL pattern:
 *   Page 1: https://www.okx.com/en-gb/copy-trading/spot
 *   Page N: https://www.okx.com/en-gb/copy-trading/spot/page/N
 *
 * SSR data is in <script id="appState"> as JSON:
 *   appContext.initialProps.tradersInfo.ranks[] — each trader has:
 *     uniqueName, nickName, yieldRatio, pnl, aum, followerNum, winRatio, initialDay, portrait
 *
 * Imports to:
 *   trader_sources  (source='okx_spot')
 *   leaderboard_ranks (source='okx_spot', season_id=PERIOD)
 *
 * Usage: node scripts/import-okx-spot-v2.mjs [--dry-run] [--period=90D]
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const PERIOD = process.argv.find(a => a.startsWith('--period='))?.split('=')[1] || '90D'
const SOURCE = 'okx_spot'

const BASE = 'https://www.okx.com/en-gb/copy-trading/spot'
// IMPORTANT: Do NOT send Accept header — OKX returns 404 if Accept: text/html is present
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseSSR(html) {
  const m = html.match(/id="appState">(.+?)<\/script>/s)
  if (!m) return null
  try {
    const data = JSON.parse(m[1])
    return data?.appContext?.initialProps?.tradersInfo || null
  } catch {
    return null
  }
}

async function fetchPage(pageNum) {
  const url = pageNum === 1 ? BASE : `${BASE}/page/${pageNum}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      })
      const html = await res.text()
      const tradersInfo = parseSSR(html)
      if (tradersInfo) return tradersInfo
      if (attempt < 2) { await sleep(1500); continue }
      throw new Error(`No SSR data in HTML (status=${res.status}, url=${res.url})`)
    } catch (e) {
      if (attempt < 2) { await sleep(1500); continue }
      throw e
    }
  }
}

async function main() {
  console.log(`\n🚀 OKX Spot Import v2 (source='${SOURCE}', period=${PERIOD})`)
  if (DRY_RUN) console.log('  [DRY RUN — no DB writes]\n')

  // Check current DB count
  const { count: existingCount } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .eq('season_id', PERIOD)
  console.log(`  Existing leaderboard_ranks (${SOURCE}, ${PERIOD}): ${existingCount}\n`)

  // Fetch page 1 to get total pages
  console.log('Fetching page 1...')
  const page1 = await fetchPage(1)
  const totalPages = page1.pages || 1
  const total = page1.total || 0
  console.log(`  Total traders: ${total}, Pages: ${totalPages}`)

  // Collect all traders
  const allTraders = []
  const addRanks = (ranks) => {
    for (const r of (ranks || [])) {
      const roi = parseFloat(r.yieldRatio || 0) * 100
      const winRate = r.winRatio != null ? parseFloat(r.winRatio) * 100 : null
      const pnl = r.pnl != null ? parseFloat(r.pnl) : null
      const aum = r.aum != null ? parseFloat(r.aum) : null
      const followers = r.followerNum != null ? parseInt(r.followerNum) : null
      const leadDays = r.initialDay != null ? parseInt(r.initialDay) : null
      allTraders.push({
        traderId: r.uniqueName,
        handle: r.nickName,
        avatarUrl: r.portrait || null,
        roi,
        pnl,
        aum,
        winRate,
        followers,
        leadDays,
      })
    }
  }

  addRanks(page1.ranks)

  for (let p = 2; p <= totalPages; p++) {
    process.stdout.write(`  Page ${p}/${totalPages} (${allTraders.length} collected)...\r`)
    try {
      const pageData = await fetchPage(p)
      addRanks(pageData.ranks)
    } catch (e) {
      console.log(`\n  ⚠ Page ${p} failed: ${e.message.slice(0, 80)}`)
    }
    await sleep(500)
  }
  console.log(`\n  Total collected: ${allTraders.length} traders`)

  // Dedup by traderId, keep first occurrence
  const seen = new Set()
  const unique = allTraders.filter(t => {
    if (seen.has(t.traderId)) return false
    seen.add(t.traderId)
    return true
  })

  // Sort by roi descending, assign ranks
  unique.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  unique.forEach((t, idx) => t.rank = idx + 1)

  console.log(`  Unique traders: ${unique.length}`)

  console.log('\n📋 Top 10:')
  for (const t of unique.slice(0, 10)) {
    console.log(`  #${t.rank} ${t.handle} (${t.traderId}) roi=${t.roi?.toFixed(2)}% wr=${t.winRate?.toFixed(1)}% followers=${t.followers}`)
  }

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete — no DB writes.')
    return
  }

  const now = new Date().toISOString()
  let inserted = 0, updated = 0, errors = 0

  console.log(`\nInserting ${unique.length} traders into leaderboard_ranks...`)
  for (const t of unique) {
    // Upsert trader_sources
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

    const lr = {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: PERIOD,
      rank: t.rank,
      handle: t.handle,
      avatar_url: t.avatarUrl,
      roi: isFinite(t.roi) ? t.roi : null,
      pnl: isFinite(t.pnl) ? t.pnl : null,
      win_rate: isFinite(t.winRate) ? t.winRate : null,
      followers: t.followers,
      computed_at: now,
    }

    const { data: ex } = await sb
      .from('leaderboard_ranks')
      .select('id')
      .eq('source', SOURCE)
      .eq('source_trader_id', t.traderId)
      .eq('season_id', PERIOD)
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
    .select('handle, season_id, rank, roi, win_rate, followers')
    .eq('source', SOURCE)
    .order('rank')
    .limit(5)
  console.log('\n  Top 5:')
  for (const r of (sample || [])) {
    console.log(`    [${r.season_id}] #${r.rank} ${r.handle} roi=${r.roi?.toFixed(2)}% wr=${r.win_rate?.toFixed(1)}% followers=${r.followers}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

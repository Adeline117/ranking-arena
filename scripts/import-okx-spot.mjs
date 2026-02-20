#!/usr/bin/env node
/**
 * OKX Spot Copy Trading Import
 *
 * Fetches spot copy traders from OKX's SSR HTML pages.
 * No API auth needed — data is server-side rendered in __app_data_for_ssr__
 *
 * URL pattern: https://www.okx.com/copy-trading/spot        (page 1)
 *              https://www.okx.com/copy-trading/spot/page/N  (pages 2+)
 *
 * Imports to: trader_snapshots (source='okx_spot')
 *             leaderboard_ranks (source='okx_spot')
 *
 * Usage:
 *   node scripts/import-okx-spot.mjs [--dry-run] [--period=90D]
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const PERIOD_ARG = process.argv.find(a => a.startsWith('--period='))?.split('=')[1] || '90D'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const BASE_URL = 'https://www.okx.com/copy-trading/spot'

function extractSSR(html) {
  const m = html.match(/id="appState">({.*?})<\/script>/s)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

async function fetchPage(pageNum) {
  // Try multiple URL formats
  const urls = pageNum === 1
    ? [BASE_URL, 'https://www.okx.com/en/copy-trading/spot', 'https://www.okx.com/en-us/copy-trading/spot']
    : [
        `${BASE_URL}/page/${pageNum}`,
        `https://www.okx.com/en/copy-trading/spot/page/${pageNum}`,
        `https://www.okx.com/en-us/copy-trading/spot/page/${pageNum}`
      ]

  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(25000)
        })
        // OKX returns 404 status but with valid SSR HTML data - ignore status code
        const html = await res.text()
        const ssr = extractSSR(html)
        if (!ssr) {
          if (attempt === 0) { await sleep(1000); continue }
          break
        }
        const tradersInfo = ssr?.appContext?.initialProps?.tradersInfo
        if (!tradersInfo) {
          if (attempt === 0) { await sleep(1000); continue }
          break
        }
        return tradersInfo
      } catch (e) {
        if (attempt === 0) { await sleep(1000); continue }
        break
      }
    }
  }
  throw new Error(`Failed to fetch page ${pageNum} from all URLs`)
}

function computeMetrics(ranks, rank) {
  const pnlRatio = parseFloat(rank.yieldRatio || 0)
  const roi = isFinite(pnlRatio * 100) ? pnlRatio * 100 : null
  const winRate = rank.winRatio != null ? parseFloat(rank.winRatio) * 100 : null
  const pnl = rank.pnl != null ? parseFloat(rank.pnl) : null
  const aum = rank.aum != null ? parseFloat(rank.aum) : null
  const copiers = rank.followerNum != null ? parseInt(rank.followerNum) : null
  const leadDays = rank.initialDay != null ? parseInt(rank.initialDay) : null
  return { roi, winRate, pnl, aum, copiers, leadDays }
}

async function main() {
  console.log(`🚀 OKX Spot Import (period=${PERIOD_ARG})\n`)
  if (DRY_RUN) console.log('  [DRY RUN — no DB writes]\n')

  // Get total pages from page 1
  console.log('Fetching page 1...')
  const page1 = await fetchPage(1)
  const totalPages = page1.pages || 1
  const total = page1.total || 0
  console.log(`  Total traders: ${total}, Pages: ${totalPages}\n`)

  // Collect all traders
  const allTraders = []
  for (const rank of (page1.ranks || [])) {
    const m = computeMetrics([], rank)
    allTraders.push({ ...rank, ...m })
  }

  for (let p = 2; p <= totalPages; p++) {
    process.stdout.write(`  Fetching page ${p}/${totalPages}...`)
    try {
      const pageData = await fetchPage(p)
      for (const rank of (pageData.ranks || [])) {
        const m = computeMetrics([], rank)
        allTraders.push({ ...rank, ...m })
      }
      console.log(` ${pageData.ranks?.length || 0} traders`)
    } catch (e) {
      console.log(` ERROR: ${e.message}`)
    }
    await sleep(500)
  }

  console.log(`\nTotal collected: ${allTraders.length} traders\n`)

  // Check how many already exist in DB
  const { data: existingIds } = await sb
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'okx_spot')

  const existingSet = new Set((existingIds || []).map(r => r.source_trader_id))
  const newTraders = allTraders.filter(t => !existingSet.has(t.uniqueName))
  console.log(`Already in DB: ${existingSet.size} | New: ${newTraders.length}`)

  if (newTraders.length === 0) {
    console.log('✅ No new traders to import.')
  }

  // Determine season IDs for leaderboard_ranks
  const now = new Date()
  const seasonId = PERIOD_ARG  // Use simple period: 7D, 30D, 90D

  let snapInserted = 0, lrInserted = 0

  for (let idx = 0; idx < allTraders.length; idx++) {
    const trader = allTraders[idx]
    const snap = {
      source: 'okx_spot',
      source_trader_id: trader.uniqueName,
      roi: trader.roi,
      pnl: trader.pnl,
      aum: trader.aum,
      win_rate: trader.winRate != null ? Math.round(trader.winRate * 100) / 100 : null,
      followers: trader.copiers,
      holding_days: trader.leadDays,
      captured_at: now.toISOString()
    }

    const lr = {
      source: 'okx_spot',
      source_trader_id: trader.uniqueName,
      season_id: seasonId,
      rank: idx + 1,
      handle: trader.nickName,
      avatar_url: trader.portrait,
      roi: trader.roi,
      pnl: trader.pnl,
      win_rate: trader.winRate != null ? Math.round(trader.winRate * 100) / 100 : null,
      followers: trader.copiers
    }

    if (!DRY_RUN) {
      // Insert snapshot (allow duplicates per day to be filtered by captured_at)
      const { error: snapErr } = await sb.from('trader_snapshots').insert(snap)
      if (snapErr) {
        if (!snapErr.message?.includes('duplicate') && !snapErr.message?.includes('unique')) {
          console.error(`  ❌ Snapshot insert failed for ${trader.uniqueName}: ${snapErr.message}`)
        }
      } else {
        snapInserted++
      }

      // Upsert leaderboard rank using update-or-insert pattern
      const { data: existing } = await sb
        .from('leaderboard_ranks')
        .select('id')
        .eq('source', 'okx_spot')
        .eq('source_trader_id', trader.uniqueName)
        .eq('season_id', seasonId)
        .limit(1)

      if (existing?.length) {
        const { error: updErr } = await sb
          .from('leaderboard_ranks')
          .update({ ...lr, computed_at: now.toISOString() })
          .eq('id', existing[0].id)
        if (!updErr) lrInserted++
      } else {
        const { error: insErr } = await sb.from('leaderboard_ranks').insert({ ...lr, computed_at: now.toISOString() })
        if (insErr) {
          console.error(`  ❌ LR insert failed for ${trader.uniqueName}: ${insErr.message}`)
        } else {
          lrInserted++
        }
      }
    } else {
      console.log(`  [DRY] ${trader.nickName} (${trader.uniqueName}) roi=${trader.roi?.toFixed(2)}% wr=${trader.winRate?.toFixed(1)}%`)
      snapInserted++
      lrInserted++
    }
  }

  console.log(`\n✅ Import done!`)
  console.log(`  trader_snapshots upserted: ${snapInserted}`)
  console.log(`  leaderboard_ranks upserted: ${lrInserted}`)

  // Verify
  console.log('\n📊 Verification:')
  const { count: snapCount } = await sb
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'okx_spot')
  const { count: lrCount } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'okx_spot')
  console.log(`  trader_snapshots (okx_spot): ${snapCount}`)
  console.log(`  leaderboard_ranks (okx_spot): ${lrCount}`)
  
  // Sample
  const { data: sample } = await sb
    .from('trader_snapshots')
    .select('source_trader_id, nickname, roi, win_rate, pnl, copiers')
    .eq('source', 'okx_spot')
    .limit(5)
  console.log('\n  Sample records:')
  for (const s of (sample || [])) {
    console.log(`    ${s.nickname} (${s.source_trader_id}) roi=${s.roi?.toFixed(2)}% wr=${s.win_rate}% copiers=${s.copiers}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

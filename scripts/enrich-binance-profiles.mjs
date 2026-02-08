#!/usr/bin/env node
/**
 * enrich-binance-profiles.mjs
 * 
 * Fetches handles + avatars for Binance Futures traders from the Binance Copy Trading API.
 * Updates trader_sources in Supabase.
 *
 * ⚠️  Binance Copy Trading APIs are geo-blocked in the US (HTTP 451).
 *     Run this script from a non-US server or with a VPN connected to Asia/Europe.
 *     Alternatively, redeploy the CF worker to a non-US region.
 *
 * Usage:
 *   node scripts/enrich-binance-profiles.mjs [--dry-run] [--limit=50] [--direct]
 *
 * Options:
 *   --dry-run   Show what would be updated without writing to DB
 *   --limit=N   Number of traders to enrich (default: 50)
 *   --direct    Skip CF proxy, hit Binance API directly (use with VPN)
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

// Load .env.local
try {
  const envLocal = readFileSync('.env.local', 'utf8')
  for (const line of envLocal.split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const DRY = process.argv.includes('--dry-run')
const DIRECT = process.argv.includes('--direct')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '50')

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const BINANCE = 'https://www.binance.com'
const LIST_API = `${BINANCE}/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list`
const PROFILE_API = `${BINANCE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail`

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': BINANCE,
  'Referer': `${BINANCE}/en/copy-trading`,
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function post(url, body) {
  if (DIRECT) {
    const res = await fetch(url, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    return res.json()
  }
  // Via CF proxy
  const proxyUrl = `${PROXY}/proxy?url=${encodeURIComponent(url)}`
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  return res.json()
}

async function testConnectivity() {
  console.log(`🔗 Testing Binance API connectivity (${DIRECT ? 'direct' : 'via proxy'})...`)
  try {
    const resp = await post(LIST_API, {
      pageNumber: 1, pageSize: 1, timeRange: 'WEEKLY',
      dataType: 'ROI', favoriteOnly: false, hideFull: false,
      nickname: '', order: 'DESC',
    })
    if (resp?.data?.list?.length > 0) {
      console.log('✅ Binance API accessible!')
      return true
    }
    if (resp?.code === 0 && resp?.msg?.includes('restricted location')) {
      console.error('❌ Binance API geo-blocked (HTTP 451)')
      console.error('   Run with --direct while connected to a non-US VPN')
      console.error('   Or redeploy the CF worker to a non-US Cloudflare region')
      return false
    }
    console.error('❌ Unexpected response:', JSON.stringify(resp).slice(0, 200))
    return false
  } catch (e) {
    console.error('❌ Connection failed:', e.message)
    return false
  }
}

async function fetchFromLeaderboard() {
  const profileMap = new Map()
  console.log('\n📋 Fetching from leaderboard list API...')

  for (const timeRange of ['WEEKLY', 'MONTHLY', 'QUARTER']) {
    for (let page = 1; page <= 5; page++) {
      try {
        const resp = await post(LIST_API, {
          pageNumber: page, pageSize: 20, timeRange,
          dataType: 'ROI', favoriteOnly: false, hideFull: false,
          nickname: '', order: 'DESC',
        })
        const list = resp?.data?.list || []
        if (!list.length) break

        for (const item of list) {
          const id = item.leadPortfolioId || item.portfolioId
          if (id && (item.nickname || item.userPhotoUrl)) {
            profileMap.set(id, {
              nickname: item.nickname || null,
              avatar: item.userPhotoUrl || null,
            })
          }
        }
        console.log(`  ${timeRange} p${page}: +${list.length} traders (total unique: ${profileMap.size})`)
        await sleep(500)
        if (list.length < 20) break
      } catch (e) {
        console.warn(`  ⚠️ ${timeRange} p${page}: ${e.message}`)
        break
      }
    }
  }
  return profileMap
}

async function fetchIndividualProfiles(traderIds, existingMap) {
  const remaining = traderIds.filter(id => !existingMap.has(id))
  if (!remaining.length) return existingMap

  console.log(`\n🔎 Fetching ${remaining.length} individual profiles...`)
  let ok = 0, fail = 0

  for (const id of remaining) {
    try {
      const resp = await post(PROFILE_API, { portfolioId: id })
      if (resp?.data?.nickname || resp?.data?.userPhotoUrl) {
        existingMap.set(id, {
          nickname: resp.data.nickname || null,
          avatar: resp.data.userPhotoUrl || null,
        })
        ok++
        if (ok % 10 === 0) console.log(`  ... ${ok} fetched`)
      } else {
        fail++
      }
    } catch (e) {
      fail++
    }
    await sleep(500)
  }
  console.log(`  ✅ ${ok} profiles fetched, ${fail} failed`)
  return existingMap
}

async function main() {
  console.log(`🚀 Binance Futures Profile Enrichment${DRY ? ' (DRY RUN)' : ''}`)
  console.log(`   Mode: ${DIRECT ? 'direct' : 'CF proxy'}, Limit: ${LIMIT}\n`)

  // Test connectivity first
  const connected = await testConnectivity()
  if (!connected) process.exit(1)

  // Get top traders needing enrichment
  console.log('\n🔍 Finding traders needing enrichment...')
  const { data: snapshots } = await supabase.from('trader_snapshots')
    .select('source_trader_id, arena_score')
    .eq('source', 'binance_futures')
    .not('arena_score', 'is', null)
    .order('arena_score', { ascending: false })
    .limit(200)

  const topIds = snapshots.map(s => s.source_trader_id)
  const { data: sources } = await supabase.from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', 'binance_futures')
    .in('source_trader_id', topIds)

  const needsEnrich = sources
    .filter(s => !s.avatar_url || !s.handle || /^\d{10,}$/.test(s.handle))
    .slice(0, LIMIT)

  console.log(`📊 ${sources.length} top traders, ${needsEnrich.length} need enrichment`)
  if (!needsEnrich.length) { console.log('✅ Nothing to do!'); return }

  // Fetch profiles from Binance
  const profileMap = await fetchFromLeaderboard()
  const traderIds = needsEnrich.map(t => t.source_trader_id)
  await fetchIndividualProfiles(traderIds, profileMap)

  console.log(`\n📊 Total profiles available: ${profileMap.size}`)

  // Update database
  let updated = 0, skipped = 0
  for (const trader of needsEnrich) {
    const profile = profileMap.get(trader.source_trader_id)
    if (!profile) { skipped++; continue }

    const updates = {}
    if (profile.nickname && /^\d{10,}$/.test(trader.handle || '')) {
      updates.handle = profile.nickname
    }
    if (profile.avatar && !trader.avatar_url) {
      updates.avatar_url = profile.avatar
    }

    if (!Object.keys(updates).length) { skipped++; continue }

    if (DRY) {
      console.log(`  [DRY] ${trader.source_trader_id} → handle:${updates.handle || '—'} avatar:${updates.avatar_url ? '✓' : '—'}`)
      updated++
      continue
    }

    const { error } = await supabase
      .from('trader_sources')
      .update(updates)
      .eq('source', 'binance_futures')
      .eq('source_trader_id', trader.source_trader_id)

    if (error) {
      console.warn(`  ❌ ${trader.source_trader_id}: ${error.message}`)
    } else {
      console.log(`  ✅ ${trader.source_trader_id} → ${updates.handle || '—'} | avatar: ${updates.avatar_url ? '✓' : '—'}`)
      updated++
    }
  }

  console.log(`\n🏁 Done: ${updated} updated, ${skipped} skipped`)
}

main().catch(e => { console.error(e); process.exit(1) })

#!/usr/bin/env node
/**
 * enrich-binance-profiles.mjs
 * Fetch handles + avatars for Binance Futures traders via CF proxy.
 * Usage: node scripts/enrich-binance-profiles.mjs [--dry-run] [--limit=50]
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
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '50')

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const PROFILE_API = 'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail'
const LIST_API = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'

async function proxyPost(url, body) {
  const proxyUrl = `${PROXY}/proxy?url=${encodeURIComponent(url)}`
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://www.binance.com',
      'Referer': 'https://www.binance.com/en/copy-trading',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  return res.json()
}

async function main() {
  console.log(`🔍 Finding Binance Futures traders needing enrichment (limit=${LIMIT})...`)

  // Get traders with missing handle or avatar
  // Handle is "missing" if it equals the numeric source_trader_id
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', 'binance_futures')
    .eq('is_active', true)
    .limit(500)

  if (error) { console.error('DB error:', error); process.exit(1) }

  // Filter to those needing enrichment (no avatar or handle == numeric ID)
  const needsEnrich = traders.filter(t =>
    !t.avatar_url || !t.handle || /^\d{10,}$/.test(t.handle)
  ).slice(0, LIMIT)

  console.log(`📊 ${traders.length} total active traders, ${needsEnrich.length} need enrichment`)
  if (!needsEnrich.length) { console.log('✅ Nothing to do'); return }

  // Strategy 1: Try bulk fetch from leaderboard list (gets ~60 traders with avatars)
  console.log('\n📋 Strategy 1: Fetching from leaderboard list API...')
  const profileMap = new Map() // portfolioId -> {nickname, avatar}

  for (const timeRange of ['WEEKLY', 'MONTHLY', 'QUARTER']) {
    for (let page = 1; page <= 3; page++) {
      try {
        const resp = await proxyPost(LIST_API, {
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
        console.log(`  ${timeRange} page ${page}: ${list.length} traders`)
        await sleep(500)
      } catch (e) {
        console.warn(`  ⚠️ ${timeRange} page ${page} failed:`, e.message)
      }
    }
  }
  console.log(`  📋 Got ${profileMap.size} profiles from list API`)

  // Strategy 2: For remaining, try individual profile API
  const remaining = needsEnrich.filter(t => !profileMap.has(t.source_trader_id))
  console.log(`\n🔎 Strategy 2: Fetching ${remaining.length} individual profiles...`)

  for (const trader of remaining) {
    try {
      const resp = await proxyPost(PROFILE_API, { portfolioId: trader.source_trader_id })
      if (resp?.data) {
        profileMap.set(trader.source_trader_id, {
          nickname: resp.data.nickname || null,
          avatar: resp.data.userPhotoUrl || null,
        })
      }
    } catch (e) {
      console.warn(`  ⚠️ ${trader.source_trader_id}: ${e.message}`)
    }
    await sleep(500)
  }

  console.log(`\n📊 Total profiles fetched: ${profileMap.size}`)

  // Update database
  let updated = 0, skipped = 0
  for (const trader of needsEnrich) {
    const profile = profileMap.get(trader.source_trader_id)
    if (!profile) { skipped++; continue }

    const updates = {}
    if (profile.nickname && profile.nickname !== trader.handle) {
      updates.handle = profile.nickname
    }
    if (profile.avatar && !trader.avatar_url) {
      updates.avatar_url = profile.avatar
    }

    if (Object.keys(updates).length === 0) { skipped++; continue }

    if (DRY) {
      console.log(`  [DRY] ${trader.source_trader_id} → ${JSON.stringify(updates)}`)
      updated++
      continue
    }

    const { error: updateError } = await supabase
      .from('trader_sources')
      .update(updates)
      .eq('source', 'binance_futures')
      .eq('source_trader_id', trader.source_trader_id)

    if (updateError) {
      console.warn(`  ❌ ${trader.source_trader_id}: ${updateError.message}`)
    } else {
      console.log(`  ✅ ${trader.source_trader_id} → ${updates.handle || '—'} | avatar: ${updates.avatar_url ? '✓' : '—'}`)
      updated++
    }
  }

  console.log(`\n🏁 Done: ${updated} updated, ${skipped} skipped`)
}

main().catch(e => { console.error(e); process.exit(1) })

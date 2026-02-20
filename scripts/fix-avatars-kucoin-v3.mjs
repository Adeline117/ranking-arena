#!/usr/bin/env node
/**
 * fix-avatars-kucoin-v3.mjs
 *
 * Comprehensive avatar fix for kucoin + kucoin_spot:
 * 1. Fetch all leaderboard pages → avatarMap
 * 2. Update NULL traders whose ID is in avatarMap
 * 3. For remaining NULL traders: try per-trader summary endpoint
 * 4. Report before/after counts
 *
 * HARD RULES:
 *   - Only update WHERE avatar_url IS NULL in trader_sources
 *   - Never overwrite existing avatars
 *   - Only real CDN URLs (must start with http), no fabrication
 *   - Do NOT touch other sources or other columns
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json',
  'Referer': 'https://www.kucoin.com/copy-trading',
  'Origin': 'https://www.kucoin.com',
}

function isRealAvatar(url) {
  if (!url || typeof url !== 'string' || url.length < 10) return false
  if (!url.startsWith('http')) return false
  const lower = url.toLowerCase()
  const fakes = ['default', 'placeholder', 'boringavatars', 'dicebear', 'identicon', 'favicon']
  return !fakes.some(f => lower.includes(f))
}

// ─── Phase 1: Collect all avatars from leaderboard ───────────────────────────

async function fetchLeaderboardPage(p) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US', {
        method: 'POST',
        headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPage: p, pageSize: 50, orderBy: 'thirtyDayPnlRatio', orderDirection: 'DESC' }),
        signal: AbortSignal.timeout(20000),
      })
      const json = await res.json()
      if (json?.success && json?.data?.items) return json.data
      await sleep(2000)
    } catch (e) {
      if (attempt < 2) { await sleep(2000); continue }
    }
  }
  return null
}

async function collectLeaderboardAvatars() {
  console.log('📡 Fetching all KuCoin leaderboard pages...')
  const avatarMap = new Map() // leadConfigId (string) -> avatarUrl

  const page1 = await fetchLeaderboardPage(1)
  if (!page1) throw new Error('Failed to fetch leaderboard page 1')
  const totalPages = page1.totalPage
  console.log(`  totalNum=${page1.totalNum}, totalPages=${totalPages}`)

  for (const item of page1.items || []) {
    if (item.leadConfigId && isRealAvatar(item.avatarUrl)) {
      avatarMap.set(String(item.leadConfigId), item.avatarUrl)
    }
  }

  for (let p = 2; p <= totalPages; p++) {
    process.stdout.write(`  Page ${p}/${totalPages} (${avatarMap.size} avatars so far)...\r`)
    const pageData = await fetchLeaderboardPage(p)
    if (!pageData) { console.log(`  ⚠️  Page ${p} failed, skipping`); continue }
    for (const item of pageData.items || []) {
      if (item.leadConfigId && isRealAvatar(item.avatarUrl)) {
        avatarMap.set(String(item.leadConfigId), item.avatarUrl)
      }
    }
    await sleep(250)
  }
  console.log(`\n  ✅ Leaderboard sweep complete: ${avatarMap.size} real avatars found`)
  return avatarMap
}

// ─── Phase 2: Per-trader summary endpoint ─────────────────────────────────────

async function fetchSummaryAvatar(leadConfigId) {
  const url = `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/summary?leadConfigId=${leadConfigId}&lang=en_US`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: BASE_HEADERS, signal: AbortSignal.timeout(15000) })
      const json = await res.json()
      if (json?.data?.avatar !== undefined) return json.data.avatar || null
      return null
    } catch (e) {
      if (attempt < 2) { await sleep(1500); continue }
      return null
    }
  }
  return null
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getAllNullTraders(source) {
  let allRows = []
  let start = 0
  while (true) {
    const { data, error } = await sb
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', source)
      .is('avatar_url', null)
      .range(start, start + 499)
    if (error) throw new Error('DB fetch error: ' + error.message)
    if (!data || data.length === 0) break
    allRows = allRows.concat(data)
    if (data.length < 500) break
    start += 500
  }
  return allRows
}

async function updateAvatar(id, avatar) {
  const { error } = await sb
    .from('trader_sources')
    .update({ avatar_url: avatar })
    .eq('id', id)
    .is('avatar_url', null) // Safety guard: only update if still NULL
  return !error
}

async function verifyCount(source) {
  const { count: total } = await sb.from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', source)
  const { count: nullCount } = await sb.from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', source).is('avatar_url', null)
  console.log(`  ${source}: total=${total}, null_avatar=${nullCount}, has_avatar=${total - nullCount}`)
  return { total, nullCount }
}

// ─── Fix a source ─────────────────────────────────────────────────────────────

async function fixSource(source, avatarMap) {
  console.log(`\n🔧 Fixing ${source}...`)

  const rows = await getAllNullTraders(source)
  console.log(`  Found ${rows.length} traders with NULL avatar_url`)
  if (rows.length === 0) return 0

  let updatedFromLeaderboard = 0, updatedFromSummary = 0, noAvatar = 0

  // Pass 1: match from leaderboard map
  const stillNull = []
  for (const row of rows) {
    const avatar = avatarMap.get(row.source_trader_id)
    if (isRealAvatar(avatar)) {
      const ok = await updateAvatar(row.id, avatar)
      if (ok) updatedFromLeaderboard++
      else stillNull.push(row)
      await sleep(30)
    } else {
      stillNull.push(row)
    }
  }
  console.log(`  Pass 1 (leaderboard): ${updatedFromLeaderboard} updated, ${stillNull.length} still NULL`)

  // Pass 2: per-trader summary endpoint for remaining NULLs
  if (stillNull.length > 0) {
    console.log(`  Pass 2 (summary endpoint): checking ${stillNull.length} traders...`)
    for (let i = 0; i < stillNull.length; i++) {
      const row = stillNull[i]
      const avatar = await fetchSummaryAvatar(row.source_trader_id)
      if (isRealAvatar(avatar)) {
        const ok = await updateAvatar(row.id, avatar)
        if (ok) {
          updatedFromSummary++
          console.log(`  ✅ [${i + 1}/${stillNull.length}] ${row.handle}: ${avatar.slice(0, 80)}`)
        }
      } else {
        noAvatar++
      }

      if ((i + 1) % 50 === 0) {
        process.stdout.write(`  Progress: ${i + 1}/${stillNull.length} | summaryUpdated=${updatedFromSummary} noAvatar=${noAvatar}\n`)
      }

      await sleep(150) // gentle rate limit
    }
  }

  const total = updatedFromLeaderboard + updatedFromSummary
  console.log(`  ✅ ${source}: leaderboard=${updatedFromLeaderboard}, summary=${updatedFromSummary}, no_avatar=${noAvatar}`)
  return total
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🖼️  KuCoin Avatar Fix v3 (kucoin + kucoin_spot)\n')

  console.log('📊 Before:')
  await verifyCount('kucoin')
  await verifyCount('kucoin_spot')

  // Phase 1: collect leaderboard avatars
  const avatarMap = await collectLeaderboardAvatars()

  // Phase 2+3: fix both sources
  const k1 = await fixSource('kucoin', avatarMap)
  const k2 = await fixSource('kucoin_spot', avatarMap)

  console.log('\n📊 After:')
  await verifyCount('kucoin')
  await verifyCount('kucoin_spot')

  console.log(`\n✅ Total updated: kucoin=${k1}, kucoin_spot=${k2}`)
  if (k1 === 0 && k2 === 0) {
    console.log('\nℹ️  All remaining NULL traders have no profile picture set in KuCoin.')
    console.log('   Avatar field returns empty string from both leaderboard and summary API.')
    console.log('   Leaving avatar_url as NULL (no placeholders allowed per task rules).')
  }
}

main().catch(e => { console.error(e); process.exit(1) })

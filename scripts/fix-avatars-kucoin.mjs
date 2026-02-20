#!/usr/bin/env node
/**
 * fix-avatars-kucoin.mjs
 * Fetch and store real avatar URLs for kucoin + kucoin_spot sources.
 * 
 * Both use the same KuCoin leaderboard API:
 *   POST https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query
 *   Returns: { leadConfigId, nickName, avatarUrl, ... }
 * 
 * HARD RULES:
 *   - Only update WHERE avatar_url IS NULL in trader_sources
 *   - Never overwrite existing avatars
 *   - Only real CDN URLs, no fabricated avatars
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

const API_URL = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query'
const PAGE_SIZE = 50
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function isRealAvatar(url) {
  if (!url || typeof url !== 'string' || url.length < 10) return false
  if (!url.startsWith('http')) return false
  const lower = url.toLowerCase()
  const fakes = ['default', 'placeholder', 'boringavatars', 'dicebear', 'identicon', 'favicon']
  return !fakes.some(f => lower.includes(f))
}

async function fetchPage(pageNum) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_URL + '?lang=en_US', {
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
      await sleep(2000)
    } catch (e) {
      if (attempt < 2) { await sleep(2000); continue }
      throw e
    }
  }
  return null
}

async function collectAllAvatars() {
  console.log('📡 Fetching KuCoin leaderboard...')
  const avatarMap = new Map() // leadConfigId (string) -> avatarUrl

  // Page 1
  const page1 = await fetchPage(1)
  if (!page1) throw new Error('Failed to fetch page 1')
  const totalPages = Math.min(page1.totalPage, 100)
  console.log(`  Total traders: ${page1.totalNum}, pages: ${page1.totalPage} (fetching up to ${totalPages})`)

  for (const item of page1.items || []) {
    if (item.leadConfigId && isRealAvatar(item.avatarUrl)) {
      avatarMap.set(String(item.leadConfigId), item.avatarUrl)
    }
  }

  for (let p = 2; p <= totalPages; p++) {
    process.stdout.write(`  Page ${p}/${totalPages} (${avatarMap.size} avatars)...\r`)
    const pageData = await fetchPage(p)
    if (!pageData) break
    for (const item of pageData.items || []) {
      if (item.leadConfigId && isRealAvatar(item.avatarUrl)) {
        avatarMap.set(String(item.leadConfigId), item.avatarUrl)
      }
    }
    await sleep(300)
  }
  console.log(`\n  Collected ${avatarMap.size} avatars from ${totalPages} pages`)
  return avatarMap
}

async function fixSource(source, avatarMap) {
  console.log(`\n🔧 Fixing ${source}...`)

  // Fetch all traders with null avatar from trader_sources
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

  console.log(`  Found ${allRows.length} traders with NULL avatar_url`)
  if (allRows.length === 0) return 0

  let updated = 0, skipped = 0

  for (const row of allRows) {
    const avatar = avatarMap.get(row.source_trader_id)
    if (!avatar) {
      skipped++
      continue
    }

    // Update trader_sources (only where avatar_url IS NULL — already filtered above)
    const { error } = await sb
      .from('trader_sources')
      .update({ avatar_url: avatar })
      .eq('id', row.id)
      .is('avatar_url', null) // double safety

    if (error) {
      console.warn(`  ❌ id=${row.id} ${row.handle}: ${error.message}`)
    } else {
      updated++
    }
    await sleep(50) // gentle rate limit
  }

  console.log(`  ✅ Updated: ${updated} | Skipped (no match): ${skipped}`)
  return updated
}

async function verify(source) {
  const { count: total } = await sb.from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', source)
  const { count: nullCount } = await sb.from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', source).is('avatar_url', null)
  console.log(`  ${source}: total=${total} null_avatar=${nullCount} has_avatar=${total - nullCount}`)
}

async function main() {
  console.log('🖼️  KuCoin Avatar Fix (kucoin + kucoin_spot)\n')

  // Before counts
  console.log('📊 Before:')
  await verify('kucoin')
  await verify('kucoin_spot')

  // Collect all available avatars from KuCoin leaderboard
  const avatarMap = await collectAllAvatars()

  // Apply to both sources
  const k1 = await fixSource('kucoin', avatarMap)
  const k2 = await fixSource('kucoin_spot', avatarMap)

  // After counts
  console.log('\n📊 After:')
  await verify('kucoin')
  await verify('kucoin_spot')

  console.log(`\n✅ Total updated: kucoin=${k1}, kucoin_spot=${k2}`)
}

main().catch(e => { console.error(e); process.exit(1) })

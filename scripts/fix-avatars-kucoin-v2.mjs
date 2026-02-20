#!/usr/bin/env node
/**
 * fix-avatars-kucoin-v2.mjs
 * 
 * Uses the summary endpoint (per-trader) to fetch avatar for each NULL trader.
 * This is more thorough than the leaderboard approach since it checks every trader individually.
 * 
 * Endpoint: GET https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/summary?leadConfigId=X&lang=en_US
 * Returns: { data: { avatar: "...", nickName: "...", ... } }
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
const HEADERS = {
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

async function fetchSummaryAvatar(leadConfigId) {
  const url = `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/summary?leadConfigId=${leadConfigId}&lang=en_US`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
      const json = await res.json()
      if (json?.data?.avatar !== undefined) {
        return json.data.avatar || null
      }
      return null
    } catch (e) {
      if (attempt < 2) { await sleep(1500); continue }
      return null
    }
  }
  return null
}

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

async function fixSource(source) {
  console.log(`\n🔧 Fixing ${source}...`)
  const rows = await getAllNullTraders(source)
  console.log(`  Found ${rows.length} traders with NULL avatar_url`)
  if (rows.length === 0) return 0

  let updated = 0, noAvatar = 0, errors = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const avatar = await fetchSummaryAvatar(row.source_trader_id)

    if (!isRealAvatar(avatar)) {
      noAvatar++
    } else {
      const { error } = await sb
        .from('trader_sources')
        .update({ avatar_url: avatar })
        .eq('id', row.id)
        .is('avatar_url', null) // Safety: only update if still NULL

      if (error) {
        console.warn(`  ❌ id=${row.id} ${row.handle}: ${error.message}`)
        errors++
      } else {
        updated++
        console.log(`  ✅ [${i+1}/${rows.length}] ${row.handle} (${row.source_trader_id}): ${avatar.slice(0, 70)}`)
      }
    }

    // Progress every 50 traders
    if ((i + 1) % 50 === 0) {
      process.stdout.write(`  Progress: ${i+1}/${rows.length} | updated=${updated} noAvatar=${noAvatar}\n`)
    }

    await sleep(200) // gentle rate limit
  }

  console.log(`  ✅ Updated: ${updated} | No avatar (API empty): ${noAvatar} | Errors: ${errors}`)
  return updated
}

async function verify(source) {
  const { count: total } = await sb.from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', source)
  const { count: nullCount } = await sb.from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', source).is('avatar_url', null)
  console.log(`  ${source}: total=${total} null_avatar=${nullCount} has_avatar=${total - nullCount}`)
}

async function main() {
  console.log('🖼️  KuCoin Avatar Fix v2 (per-trader summary endpoint)\n')
  console.log('📊 Before:')
  await verify('kucoin')
  await verify('kucoin_spot')

  const k1 = await fixSource('kucoin')
  const k2 = await fixSource('kucoin_spot')

  console.log('\n📊 After:')
  await verify('kucoin')
  await verify('kucoin_spot')

  console.log(`\n✅ Total updated: kucoin=${k1}, kucoin_spot=${k2}`)
  if (k1 === 0 && k2 === 0) {
    console.log('\nℹ️  These traders have no profile avatar set in KuCoin.')
    console.log('   Their avatarUrl returns empty string from the API.')
    console.log('   Leaving avatar_url as NULL per task rules (no placeholders).')
  }
}

main().catch(e => { console.error(e); process.exit(1) })

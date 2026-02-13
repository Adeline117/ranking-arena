#!/usr/bin/env node
/**
 * enrich-avatars-binance.mjs — Batch fetch avatar_url for binance_futures traders
 * Uses Binance Copy Trading detail API via proxy.
 * Usage: node scripts/enrich-avatars-binance.mjs [--test] [--limit=N]
 */
import { exec } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(exec)

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const PROXY = 'http://127.0.0.1:7890'

const TEST_MODE = process.argv.includes('--test')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || (TEST_MODE ? '20' : '5000'))
const CONCURRENCY = 5
const sleep = ms => new Promise(r => setTimeout(r, ms))

const sbHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal'
}

async function supabaseGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders })
  if (!r.ok) throw new Error(`Supabase: ${r.status}`)
  return r.json()
}

async function supabaseUpdate(table, id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: sbHeaders, body: JSON.stringify(data)
  })
  if (!r.ok) throw new Error(`Update: ${r.status}`)
}

async function fetchBinanceAvatar(portfolioId) {
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 8 -x ${PROXY} --compressed 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${portfolioId}' -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' -H 'Origin: https://www.binance.com' -H 'Referer: https://www.binance.com/en/copy-trading'`,
      { timeout: 12000 }
    )
    const json = JSON.parse(stdout)
    const url = json?.data?.avatarUrl
    if (url && url.startsWith('http') && url.length > 10) return url
  } catch {}
  return null
}

async function enrichBinanceFutures() {
  console.log(`\n🔍 Fetching binance_futures traders with NULL avatar (limit=${LIMIT})...`)
  const traders = await supabaseGet(
    `trader_sources?source=eq.binance_futures&avatar_url=is.null&select=id,source_trader_id,handle&limit=${LIMIT}`
  )
  console.log(`Found ${traders.length} traders`)
  if (!traders.length) return

  let updated = 0, failed = 0
  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async t => {
      const avatar = await fetchBinanceAvatar(t.source_trader_id)
      return { t, avatar }
    }))
    for (const { t, avatar } of results) {
      if (avatar) {
        await supabaseUpdate('trader_sources', t.id, { avatar_url: avatar })
        updated++
      } else {
        failed++
      }
    }
    const done = Math.min(i + CONCURRENCY, traders.length)
    console.log(`  ${done}/${traders.length} | ✅ ${updated} | ❌ ${failed}`)
    await sleep(300)
  }
  console.log(`\n✅ Binance: ${updated} updated, ${failed} failed`)
}

async function enrichLeaderboardRanks() {
  console.log(`\n🔍 Fetching leaderboard_ranks binance_futures with NULL avatar (limit=${LIMIT})...`)
  
  // First, get avatars already in trader_sources to avoid redundant API calls
  const known = await supabaseGet(
    `trader_sources?source=eq.binance_futures&avatar_url=not.is.null&select=source_trader_id,avatar_url&limit=5000`
  )
  const cache = new Map(known.map(t => [t.source_trader_id, t.avatar_url]))
  console.log(`  ${cache.size} avatars cached from trader_sources`)

  const traders = await supabaseGet(
    `leaderboard_ranks?source=eq.binance_futures&avatar_url=is.null&select=id,source_trader_id,handle&limit=${LIMIT}`
  )
  console.log(`  Found ${traders.length} leaderboard entries without avatars`)
  if (!traders.length) return

  let updated = 0, failed = 0, fromCache = 0
  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async t => {
      // Check cache first
      if (cache.has(t.source_trader_id)) return { t, avatar: cache.get(t.source_trader_id) }
      const avatar = await fetchBinanceAvatar(t.source_trader_id)
      if (avatar) cache.set(t.source_trader_id, avatar) // cache for later
      return { t, avatar }
    }))
    for (const { t, avatar } of results) {
      if (avatar) {
        await supabaseUpdate('leaderboard_ranks', t.id, { avatar_url: avatar })
        updated++
        if (cache.has(t.source_trader_id)) fromCache++
      } else {
        failed++
      }
    }
    const done = Math.min(i + CONCURRENCY, traders.length)
    if (done % 50 === 0 || done === traders.length) {
      console.log(`  ${done}/${traders.length} | ✅ ${updated} (${fromCache} cached) | ❌ ${failed}`)
    }
    await sleep(200)
  }
  console.log(`\n✅ Leaderboard Ranks: ${updated} updated (${fromCache} from cache), ${failed} failed`)
}

async function main() {
  console.log(`🖼️  Avatar Enrichment ${TEST_MODE ? '(TEST)' : '(FULL)'}`)
  await enrichBinanceFutures()
  await enrichLeaderboardRanks()
  console.log('\nDone!')
}

main().catch(e => { console.error(e); process.exit(1) })

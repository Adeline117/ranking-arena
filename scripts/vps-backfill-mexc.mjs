#!/usr/bin/env node
/**
 * MEXC nickname backfill - run on VPS to bypass geo-blocking.
 * Self-contained, no npm dependencies (uses fetch + direct Supabase REST API).
 * 
 * Usage: scp this to VPS, then: node vps-backfill-mexc.mjs
 */

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Supabase REST API helpers
async function supabaseGet(table, params = '') {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  return resp.json()
}

async function supabasePatch(table, match, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${match}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify(data)
  })
  return resp.ok
}

// Get MEXC traders with bad handles
async function getBadTraders() {
  const all = []
  let offset = 0
  while (true) {
    const data = await supabaseGet('trader_sources',
      `source=eq.mexc&select=id,source_trader_id,handle&offset=${offset}&limit=1000`)
    if (!data || !data.length) break
    for (const d of data) {
      if (d.handle === d.source_trader_id || /^Mexctrader-/.test(d.handle))
        all.push(d)
    }
    offset += 1000
    if (data.length < 1000) break
  }
  return all
}

// Fetch nickname from MEXC API
async function fetchMexcNickname(traderId) {
  try {
    const resp = await fetch(
      `https://www.mexc.com/api/platform/copy-trade/trader/detail?traderId=${traderId}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.mexc.com', Referer: 'https://www.mexc.com/copy-trading' } }
    )
    if (!resp.ok) return null
    const json = await resp.json()
    return { nickname: json?.data?.nickName || null, avatar: json?.data?.avatar || null }
  } catch { return null }
}

// Also try leaderboard scraping for bulk data
async function fetchMexcLeaderboard() {
  const traders = new Map()
  for (const sortType of ['ROI', 'PNL', 'FOLLOWERS', 'COPIER_NUM']) {
    for (const days of ['7', '30', '90']) {
      for (let page = 1; page <= 50; page++) {
        try {
          const params = new URLSearchParams({
            pageNum: String(page), pageSize: '20', sortType, days
          })
          const resp = await fetch(
            `https://www.mexc.com/api/platform/copy/v1/recommend/traders?${params}`,
            { headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.mexc.com' } }
          )
          if (!resp.ok) break
          const data = await resp.json()
          const list = data?.data?.list || data?.data || []
          if (!Array.isArray(list) || !list.length) break
          
          for (const t of list) {
            const id = String(t.traderId || t.uid || t.id || '')
            const nick = t.nickName || t.nickname || ''
            if (id && nick && !/^\d+$/.test(nick))
              traders.set(id, { nickname: nick, avatar: t.avatar || null })
          }
          await sleep(500)
        } catch { break }
      }
    }
  }
  return traders
}

async function main() {
  console.log('🔄 Phase 1: Fetching MEXC leaderboard...')
  const leaderboard = await fetchMexcLeaderboard()
  console.log(`   Got ${leaderboard.size} traders from leaderboard`)

  console.log('🔍 Getting bad traders from DB...')
  const badTraders = await getBadTraders()
  console.log(`   Found ${badTraders.length} traders to fix`)

  let updated = 0, apiCalls = 0, consecutiveFails = 0

  // Phase 2: Update from leaderboard data
  for (const t of badTraders) {
    const info = leaderboard.get(t.source_trader_id)
    if (info?.nickname) {
      const data = { handle: info.nickname }
      if (info.avatar) data.avatar_url = info.avatar
      if (await supabasePatch('trader_sources', `id=eq.${t.id}`, data)) {
        updated++
        if (updated <= 5) console.log(`   ✅ ${t.handle} → ${info.nickname}`)
      }
    }
  }
  console.log(`\n📊 Phase 2 (leaderboard): ${updated} updated`)

  // Phase 3: Fetch individual profiles for remaining
  const remaining = badTraders.filter(t => !leaderboard.has(t.source_trader_id))
  console.log(`\n🔄 Phase 3: Fetching ${remaining.length} individual profiles...`)
  
  for (let i = 0; i < remaining.length; i++) {
    const t = remaining[i]
    const result = await fetchMexcNickname(t.source_trader_id)
    apiCalls++
    
    if (result?.nickname && result.nickname !== t.handle && !/^\d+$/.test(result.nickname)) {
      const data = { handle: result.nickname }
      if (result.avatar) data.avatar_url = result.avatar
      if (await supabasePatch('trader_sources', `id=eq.${t.id}`, data)) {
        updated++
        consecutiveFails = 0
        if (updated % 50 === 0 || i < 10)
          console.log(`   [${i+1}/${remaining.length}] ${t.source_trader_id} → ${result.nickname}`)
      }
    } else {
      consecutiveFails++
    }
    
    // Stop if API consistently fails
    if (consecutiveFails > 30 && apiCalls > 50) {
      console.log('⚠️  Too many consecutive failures, API might be blocked')
      break
    }
    
    await sleep(2000 + Math.random() * 2000)
    if (i % 100 === 0 && i > 0) console.log(`   Progress: ${i}/${remaining.length}, updated: ${updated}`)
  }

  console.log(`\n✅ Done! Total updated: ${updated}/${badTraders.length}`)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })

#!/usr/bin/env node
/**
 * Import XT.com Spot Copy Trading traders
 * New source: xt_spot
 * NO fabricated data - only real API values
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

async function main() {
  console.log('XT.com Spot — Import copy trading traders')

  const seen = new Set()
  let allTraders = []

  // API returns multiple sort categories in result array
  // Fetch by INCOME_RATE sort with pagination
  for (let page = 1; page <= 100; page++) {
    const url = `https://www.xt.com/sapi/v4/account/public/copy-trade/elite-leader-list-v3?page=${page}&size=20&sortField=roi&sortType=desc`
    const data = await fetchJSON(url)

    if (!data?.result) break

    let found = 0
    for (const section of data.result) {
      if (!section?.items?.length) continue
      for (const t of section.items) {
        const id = t.accountId || t.aid
        if (!id || seen.has(String(id))) continue
        seen.add(String(id))
        allTraders.push(t)
        found++
      }
    }

    if (!found) {
      console.log(`  Page ${page}: no new traders`)
      break
    }
    console.log(`  Page ${page}: +${found} traders (total: ${allTraders.length})`)
    await sleep(500)
  }

  // Also fetch by other sort types
  for (const sortField of ['follower', 'profit', 'steady']) {
    for (let page = 1; page <= 50; page++) {
      const url = `https://www.xt.com/sapi/v4/account/public/copy-trade/elite-leader-list-v3?page=${page}&size=20&sortField=${sortField}&sortType=desc`
      const data = await fetchJSON(url)
      if (!data?.result) break

      let found = 0
      for (const section of data.result) {
        if (!section?.items?.length) continue
        for (const t of section.items) {
          const id = t.accountId || t.aid
          if (!id || seen.has(String(id))) continue
          seen.add(String(id))
          allTraders.push(t)
          found++
        }
      }

      if (!found) break
      console.log(`  [${sortField}] Page ${page}: +${found} (total: ${allTraders.length})`)
      await sleep(500)
    }
  }

  console.log(`\nTotal unique traders: ${allTraders.length}`)
  if (!allTraders.length) return

  // Upsert into leaderboard_ranks
  let inserted = 0, updated = 0, failed = 0

  for (const t of allTraders) {
    const traderId = String(t.accountId || t.aid)
    const roi = t.incomeRate != null ? parseFloat((parseFloat(t.incomeRate) * 100).toFixed(2)) : null
    const pnl = t.income != null ? parseFloat(t.income) : null
    const winRate = t.winRate != null ? parseFloat((parseFloat(t.winRate) * 100).toFixed(2)) : null
    const mdd = t.maxRetraction != null ? parseFloat((parseFloat(t.maxRetraction) * 100).toFixed(2)) : null
    const tc = t.tradeDays != null ? parseInt(t.tradeDays) : null
    const followers = t.followerCount != null ? parseInt(t.followerCount) : null
    const nickname = t.nickName || null
    const avatar = t.avatar || null

    // Check existing
    const { data: existing } = await supabase.from('leaderboard_ranks')
      .select('id')
      .eq('source', 'xt_spot')
      .eq('source_trader_id', traderId)
      .limit(1)

    const idx = allTraders.indexOf(t)
    const record = {
      source: 'xt_spot',
      source_trader_id: traderId,
      rank: idx + 1,
      roi, pnl,
      win_rate: winRate,
      max_drawdown: mdd,
      trades_count: tc,
      followers,
      handle: nickname,
      avatar_url: avatar,
      season_id: '90D',
    }

    if (existing?.length) {
      const { error } = await supabase.from('leaderboard_ranks').update(record).eq('id', existing[0].id)
      if (!error) updated++; else failed++
    } else {
      const { error } = await supabase.from('leaderboard_ranks').insert(record)
      if (!error) inserted++
      else { failed++; if (failed <= 3) console.log('  Insert error:', error.message) }
    }

    if ((inserted + updated + failed) % 20 === 0) {
      console.log(`  LR progress: inserted=${inserted} updated=${updated} failed=${failed}`)
    }
    await sleep(100)
  }

  console.log(`\nLeaderboard: inserted=${inserted} updated=${updated} failed=${failed}`)

  // Also insert into trader_snapshots
  console.log('\nInserting into trader_snapshots...')
  let snapInserted = 0

  for (const t of allTraders) {
    const traderId = String(t.accountId || t.aid)
    const { data: existing } = await supabase.from('trader_snapshots')
      .select('id').eq('source', 'xt_spot').eq('source_trader_id', traderId).limit(1)

    if (existing?.length) continue

    const snap = {
      source: 'xt_spot',
      source_trader_id: traderId,
      roi: t.incomeRate != null ? parseFloat((parseFloat(t.incomeRate) * 100).toFixed(2)) : null,
      pnl: t.income != null ? parseFloat(t.income) : null,
      win_rate: t.winRate != null ? parseFloat((parseFloat(t.winRate) * 100).toFixed(2)) : null,
      max_drawdown: t.maxRetraction != null ? parseFloat((parseFloat(t.maxRetraction) * 100).toFixed(2)) : null,
      followers: t.followerCount != null ? parseInt(t.followerCount) : null,
    }

    const { error } = await supabase.from('trader_snapshots').insert(snap)
    if (!error) snapInserted++
    await sleep(50)
  }

  console.log(`Snapshots inserted: ${snapInserted}`)
  console.log('\nDONE!')
}

main().catch(console.error)

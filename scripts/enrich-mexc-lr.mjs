#!/usr/bin/env node
/**
 * enrich-mexc-lr.mjs
 * Direct API enrichment for MEXC leaderboard_ranks (WR + MDD).
 *
 * Uses MEXC copy trading API which works without browser.
 * Matches by nickname (source_trader_id in our DB = trader's nickname).
 *
 * API returns decimals: winRate=0.5732 → 57.32%, maxDrawdown7=0.016 → 1.6%
 */

import pg from 'pg'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_URL
const { Client } = pg

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.mexc.com/futures/copyTrade/home',
  'Origin': 'https://www.mexc.com',
}
const DELAY = 300
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchPage(orderBy, page, limit = 30) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=${limit}&orderBy=${orderBy}&page=${page}`
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
      if (!res.ok) { await sleep(2000); continue }
      return await res.json()
    } catch { if (attempt < 2) await sleep(2000) }
  }
  return null
}

async function main() {
  console.log('=== MEXC LR Enrichment (Direct API) ===')
  console.log(`Started: ${new Date().toISOString()}`)

  const client = new Client(DB_URL)
  await client.connect()

  // Load null rows
  const { rows: nullRows } = await client.query(
    `SELECT id, source_trader_id, season_id, win_rate, max_drawdown
     FROM leaderboard_ranks
     WHERE source='mexc' AND (win_rate IS NULL OR max_drawdown IS NULL)`
  )
  console.log(`Null WR/MDD rows: ${nullRows.length}`)

  if (!nullRows.length) { console.log('Nothing to do.'); await client.end(); return }

  // Build lookup by lowercase nickname
  const byNick = new Map()
  for (const row of nullRows) {
    const key = row.source_trader_id.toLowerCase().trim()
    if (!byNick.has(key)) byNick.set(key, [])
    byNick.get(key).push(row)
  }
  console.log(`Unique nicknames: ${byNick.size}`)

  // Paginate API with multiple sort orders
  const apiData = new Map() // lowercase nickname → {wr, mdd}
  const orderBys = ['COMPREHENSIVE', 'FOLLOWERS', 'ROI', 'WINRATE', 'PNL', 'TRADE_COUNT']

  for (const orderBy of orderBys) {
    let stale = 0
    for (let page = 1; page <= 200; page++) {
      const json = await fetchPage(orderBy, page, 30)
      if (!json || json.code !== 0 || !json.data?.content?.length) break

      let newFound = 0
      for (const t of json.data.content) {
        const nick = (t.nickname || '').toLowerCase().trim()
        if (!nick || apiData.has(nick)) continue

        const wr = t.winRate != null ? parseFloat(t.winRate) : null
        const mdd = t.maxDrawdown7 != null ? Math.abs(parseFloat(t.maxDrawdown7)) : 
                    t.maxDrawdown != null ? Math.abs(parseFloat(t.maxDrawdown)) : null

        apiData.set(nick, {
          wr: wr != null ? (wr <= 1 ? Math.round(wr * 10000) / 100 : wr) : null,
          mdd: mdd != null ? (mdd <= 1 ? Math.round(mdd * 10000) / 100 : mdd) : null,
        })
        newFound++
      }

      if (page % 50 === 0) process.stdout.write(`  ${orderBy} page ${page}: ${apiData.size} traders\r`)

      if (newFound === 0) { stale++; if (stale >= 3) break } else stale = 0
      
      const totalPages = json.data?.totalPages
      if (totalPages && page >= totalPages) break

      await sleep(DELAY)
    }
    console.log(`  After orderBy=${orderBy}: ${apiData.size} traders collected`)
  }

  console.log(`\nTotal traders from API: ${apiData.size}`)
  const coverable = [...byNick.keys()].filter(k => apiData.has(k))
  console.log(`Coverable: ${coverable.length}/${byNick.size}`)

  // Update DB
  let updated = 0, skipped = 0
  for (const [nick, rows] of byNick) {
    const d = apiData.get(nick)
    if (!d) { skipped += rows.length; continue }

    for (const row of rows) {
      const updates = []
      const vals = []
      let pi = 1

      if (row.win_rate == null && d.wr != null) { updates.push(`win_rate=$${pi++}`); vals.push(d.wr) }
      if (row.max_drawdown == null && d.mdd != null) { updates.push(`max_drawdown=$${pi++}`); vals.push(d.mdd) }
      if (!updates.length) { skipped++; continue }

      vals.push(row.id)
      try {
        await client.query(`UPDATE leaderboard_ranks SET ${updates.join(',')} WHERE id=$${pi}`, vals)
        updated++
      } catch (e) {
        console.error(`  ERR id=${row.id}: ${e.message}`)
      }
    }
  }

  // Final counts
  const { rows: [g] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE win_rate IS NULL) as wr_null, COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null FROM leaderboard_ranks WHERE source='mexc'`
  )

  console.log(`\n=== DONE ===`)
  console.log(`Updated: ${updated} rows`)
  console.log(`Skipped (no API data): ${skipped}`)
  console.log(`MEXC WR null remaining: ${g.wr_null}`)
  console.log(`MEXC MDD null remaining: ${g.mdd_null}`)
  console.log(`Completed: ${new Date().toISOString()}`)

  await client.end()
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })

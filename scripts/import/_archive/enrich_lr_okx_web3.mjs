#!/usr/bin/env node
/**
 * OKX Web3 leaderboard_ranks enrichment — fill win_rate & max_drawdown
 * 
 * Fetches from OKX Web3 Smart Money ranking API, matches by truncated address.
 * Target table: leaderboard_ranks (NOT trader_snapshots)
 * 
 * Usage: node scripts/import/enrich_lr_okx_web3.mjs
 */

import pg from 'pg'
const { Client } = pg

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const SOURCE = 'okx_web3'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2/smartmoney/ranking/content'

const PERIOD_MAP = { '7D': '1', '30D': '2', '90D': '3' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

function truncateAddress(addr) {
  if (!addr || addr.length < 11) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function computeMDD(pnlHistory) {
  if (!pnlHistory?.length || pnlHistory.length < 2) return null
  const values = pnlHistory.map(h => parseFloat(h.pnl)).filter(v => !isNaN(v))
  if (values.length < 2) return null
  let peak = values[0], maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) { const dd = ((peak - v) / peak) * 100; if (dd > maxDD) maxDD = dd }
  }
  return maxDD > 0 && maxDD <= 100 ? parseFloat(maxDD.toFixed(2)) : null
}

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) {
        console.log(`  ⚠️ 429 rate limit, waiting ${3 * (i + 1)}s...`)
        await sleep(3000 * (i + 1))
        continue
      }
      if (!res.ok) return null
      return await res.json()
    } catch {
      if (i < 2) await sleep(1000)
    }
  }
  return null
}

async function fetchAllTraders(periodType) {
  const all = new Map() // truncated -> trader data
  for (let start = 0; start < 3000; start += 20) {
    const url = `${BASE}?rankStart=${start}&periodType=${periodType}&rankBy=1&label=all&desc=true&rankEnd=${start + 20}&chainId=501`
    const json = await fetchJSON(url)
    const infos = json?.data?.rankingInfos || []
    if (infos.length === 0) break
    for (const t of infos) {
      const addr = t.walletAddress
      if (!addr) continue
      const trunc = truncateAddress(addr)
      if (all.has(trunc)) continue
      all.set(trunc, {
        winRate: t.winRate != null ? parseFloat(t.winRate) : null,
        mdd: computeMDD(t.pnlHistory),
      })
    }
    if (start % 200 === 0 && start > 0) console.log(`    ... ${all.size} traders fetched`)
    await sleep(150)
  }
  return all
}

async function main() {
  const client = new Client(DB_URL)
  await client.connect()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`OKX Web3 leaderboard_ranks Enrichment`)
  console.log(`${'='.repeat(60)}`)

  // Get null rows
  const { rows: nullRows } = await client.query(
    `SELECT id, source_trader_id, season_id FROM leaderboard_ranks WHERE source=$1 AND win_rate IS NULL`,
    [SOURCE]
  )
  console.log(`Total null win_rate rows: ${nullRows.length}`)

  // Group by season
  const bySeason = {}
  for (const row of nullRows) {
    if (!bySeason[row.season_id]) bySeason[row.season_id] = []
    bySeason[row.season_id].push(row)
  }

  let totalUpdated = 0

  for (const [period, periodType] of Object.entries(PERIOD_MAP)) {
    const rows = bySeason[period] || []
    if (rows.length === 0) { console.log(`\n--- ${period}: no null rows, skip`); continue }
    
    console.log(`\n--- ${period}: ${rows.length} null rows ---`)
    console.log(`  Fetching from API...`)
    const apiTraders = await fetchAllTraders(periodType)
    console.log(`  Fetched ${apiTraders.size} traders from API`)

    let matched = 0, updated = 0

    for (const row of rows) {
      const t = apiTraders.get(row.source_trader_id)
      if (!t) continue
      matched++

      const updates = []
      const values = []
      let paramIdx = 1

      if (t.winRate != null && !isNaN(t.winRate)) {
        updates.push(`win_rate = $${paramIdx++}`)
        values.push(t.winRate)
      }
      if (t.mdd != null) {
        updates.push(`max_drawdown = $${paramIdx++}`)
        values.push(t.mdd)
      }

      if (updates.length === 0) continue

      values.push(row.id)
      await client.query(
        `UPDATE leaderboard_ranks SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
        values
      )
      updated++
    }

    console.log(`  Matched: ${matched}, Updated: ${updated}`)
    totalUpdated += updated
  }

  // Final check
  const { rows: [{ count }] } = await client.query(
    `SELECT COUNT(*) FROM leaderboard_ranks WHERE source=$1 AND win_rate IS NULL`,
    [SOURCE]
  )

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Done. Updated: ${totalUpdated}, Remaining null: ${count}`)
  console.log(`${'='.repeat(60)}`)

  await client.end()
}

main().catch(e => { console.error(e); process.exit(1) })

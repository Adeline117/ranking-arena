#!/usr/bin/env node
/**
 * Enrich Bybit PNL + Equity Curves via direct API
 */
import { readFileSync } from 'fs'
try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
      if (res.status === 429) { await sleep(5000 * (i + 1)); continue }
      if (!res.ok) return null
      const text = await res.text()
      if (text.startsWith('<')) return null
      return JSON.parse(text)
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

const INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'
const YIELD_URL = 'https://api2.bybit.com/fapi/beehive/public/v2/leader/yield-trend'
const PERIODS = { '7D': 'DAY_CYCLE_TYPE_SEVEN_DAY', '30D': 'DAY_CYCLE_TYPE_THIRTY_DAY', '90D': 'DAY_CYCLE_TYPE_NINETY_DAY' }

async function main() {
  const { rows } = await db.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'bybit' AND pnl IS NULL 
      AND (source_trader_id LIKE '%==%' OR source_trader_id ~ '^\\d{9,}$')
    LIMIT $1
  `, [LIMIT])
  
  console.log(`📊 Bybit: ${rows.length} traders with null PNL`)
  if (!rows.length) { await db.end(); return }
  let pnlN = 0, equityN = 0, errors = 0, skipped = 0
  const now = new Date().toISOString()

  for (let i = 0; i < rows.length; i++) {
    const tid = rows[i].source_trader_id
    const enc = encodeURIComponent(tid)
    console.log(`  → [${i+1}] ${tid}`)

    try {
      // Fetch income stats
      console.log(`    fetching income...`)
      const json = await fetchJSON(`${INCOME_URL}?leaderMark=${enc}`)
      console.log(`    got:`, json?.retCode)
      if (!json || json.retCode !== 0 || !json.result) { skipped++; await sleep(300); continue }
      
      const r = json.result
      const cumPnl = parseInt(r.cumYieldE8 || '0') / 1e8
      
      if (cumPnl !== 0) {
        const res = await db.query(
          `UPDATE trader_snapshots SET pnl = $1 WHERE source = 'bybit' AND source_trader_id = $2 AND pnl IS NULL`,
          [cumPnl, tid]
        )
        if (res.rowCount > 0) pnlN++
      }
      await sleep(500)

      // Fetch equity curves
      for (const [period, cycleType] of Object.entries(PERIODS)) {
        const yJson = await fetchJSON(`${YIELD_URL}?dayCycleType=${cycleType}&period=PERIOD_DAY&leaderMark=${enc}`)
        const trend = yJson?.result?.yieldTrend
        if (trend?.length > 0) {
          const points = trend.map(p => ({
            source: 'bybit', source_trader_id: tid, period,
            data_date: new Date(parseInt(p.statisticDate)).toISOString().split('T')[0],
            roi_pct: parseInt(p.cumResetRoiE4 || p.yieldRateE4 || '0') / 100,
            pnl_usd: parseInt(p.cumResetPnlE8 || p.yieldE8 || '0') / 1e8,
            captured_at: now,
          }))
          const { error } = await sb.from('trader_equity_curve')
            .upsert(points, { onConflict: 'source,source_trader_id,period,data_date' })
          if (!error) equityN++
          else console.log(`  ⚠ eq: ${error.message}`)
        }
        await sleep(400)
      }
    } catch (e) {
      errors++
      if (errors <= 3) console.log(`  ⚠ ${tid}: ${e.message}`)
    }

    if ((i + 1) % 20 === 0 || i === rows.length - 1) {
      console.log(`  [${i+1}/${rows.length}] pnl=${pnlN} equity=${equityN} skip=${skipped} err=${errors}`)
    }
  }

  console.log(`\n✅ Bybit done: PNL=${pnlN} equity=${equityN}`)
  await db.end()
}

main().catch(e => { console.error(e); process.exit(1) })

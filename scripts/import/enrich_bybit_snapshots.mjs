#!/usr/bin/env node
/**
 * Bybit Snapshot Enrichment via leader-income API
 * Fills: pnl, win_rate, trades_count, max_drawdown, aum
 * Run from VPS (US WAF-blocked)
 * Usage: node enrich_bybit_snapshots.mjs [--limit=500] [--dry-run]
 */

import pg from 'pg'
const { Pool } = pg

const DB_URL = "postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres"
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const API_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'

const DRY_RUN = process.argv.includes('--dry-run')
const limitArg = process.argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 99999
const sleep = ms => new Promise(r => setTimeout(r, ms))

const SEASONS = {
  '7D':  { pnl: 'sevenDayProfitE8', dd: 'sevenDayDrawDownE4', win: 'sevenDayWinCount', loss: 'sevenDayLossCount', wr: 'sevenDayProfitWinRateE4' },
  '30D': { pnl: 'thirtyDayProfitE8', dd: 'thirtyDayDrawDownE4', win: 'thirtyDayWinCount', loss: 'thirtyDayLossCount', wr: 'thirtyDayProfitWinRateE4' },
  '90D': { pnl: 'ninetyDayProfitE8', dd: 'ninetyDayDrawDownE4', win: 'ninetyDayWinCount', loss: 'ninetyDayLossCount', wr: 'ninetyDayProfitWinRateE4' },
}

async function fetchAPI(leaderMark) {
  const url = `${API_URL}?leaderMark=${encodeURIComponent(leaderMark)}`
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
      if (res.status === 429) { await sleep(5000 * (i + 1)); continue }
      if (!res.ok) return null
      const text = await res.text()
      if (text.startsWith('<')) return null
      const json = JSON.parse(text)
      return json.retCode === 0 ? json.result : null
    } catch { if (i < 2) await sleep(2000) }
  }
  return null
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  
  console.log('='.repeat(60))
  console.log('Bybit Snapshot Enrichment' + (DRY_RUN ? ' (DRY RUN)' : ''))
  console.log('='.repeat(60))

  // BEFORE
  const before = await pool.query(`
    SELECT season_id, count(*) total, count(pnl) pnl, count(win_rate) wr,
      count(trades_count) tc, count(max_drawdown) mdd, count(aum) aum
    FROM trader_snapshots WHERE source='bybit' GROUP BY season_id ORDER BY season_id`)
  console.log('\nBEFORE:')
  before.rows.forEach(r => console.log(`  ${r.season_id}: total=${r.total} pnl=${r.pnl} wr=${r.wr} tc=${r.tc} mdd=${r.mdd} aum=${r.aum}`))

  // Get traders needing enrichment
  const res = await pool.query(`
    SELECT DISTINCT source_trader_id FROM trader_snapshots
    WHERE source='bybit' AND source_trader_id NOT LIKE '$_%' ESCAPE '$'
    AND (trades_count IS NULL OR aum IS NULL)
    LIMIT $1`, [LIMIT])
  
  const ids = res.rows.map(r => r.source_trader_id)
  console.log(`\nTo enrich: ${ids.length}`)
  if (DRY_RUN || ids.length === 0) { await pool.end(); return }

  let ok = 0, skip = 0, err = 0
  const t0 = Date.now()

  for (let i = 0; i < ids.length; i++) {
    const tid = ids[i]
    try {
      const d = await fetchAPI(tid)
      if (!d || parseInt(d.cumTradeCount || '0') === 0) { skip++; await sleep(300); continue }

      const aum = parseInt(d.aumE8 || '0') / 1e8

      for (const [season, f] of Object.entries(SEASONS)) {
        const wins = parseInt(d[f.win] || '0')
        const losses = parseInt(d[f.loss] || '0')
        const tc = wins + losses
        const pnl = parseInt(d[f.pnl] || '0') / 1e8
        const dd = parseInt(d[f.dd] || '0') / 100
        const wr = parseInt(d[f.wr] || '0') / 100

        await pool.query(`
          UPDATE trader_snapshots SET
            trades_count = COALESCE(trades_count, $1),
            pnl = COALESCE(pnl, $2),
            max_drawdown = COALESCE(max_drawdown, $3),
            win_rate = COALESCE(win_rate, $4),
            aum = COALESCE(aum, $5)
          WHERE source='bybit' AND source_trader_id=$6 AND season_id=$7`,
          [tc > 0 ? tc : null, pnl !== 0 ? pnl : null, dd > 0 ? dd : null, wr > 0 ? wr : null, aum > 0 ? aum : null, tid, season])
      }
      ok++
    } catch (e) {
      err++
      if (err <= 3) console.error(`  Error ${tid}: ${e.message}`)
    }

    await sleep(500)
    if ((i + 1) % 50 === 0 || i === ids.length - 1) {
      const min = ((Date.now() - t0) / 60000).toFixed(1)
      console.log(`  [${i + 1}/${ids.length}] ok=${ok} skip=${skip} err=${err} | ${min}m`)
    }
  }

  // AFTER
  const after = await pool.query(`
    SELECT season_id, count(*) total, count(pnl) pnl, count(win_rate) wr,
      count(trades_count) tc, count(max_drawdown) mdd, count(aum) aum
    FROM trader_snapshots WHERE source='bybit' GROUP BY season_id ORDER BY season_id`)
  console.log('\nAFTER:')
  after.rows.forEach(r => console.log(`  ${r.season_id}: total=${r.total} pnl=${r.pnl} wr=${r.wr} tc=${r.tc} mdd=${r.mdd} aum=${r.aum}`))

  console.log(`\n✅ Done: ok=${ok} skip=${skip} err=${err} | ${((Date.now() - t0) / 60000).toFixed(1)}m`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })

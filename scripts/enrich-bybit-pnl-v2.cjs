#!/usr/bin/env node
/**
 * Enrich Bybit PNL + Equity Curves via direct API
 * Uses pg Pool (not Client) to avoid connection hanging
 */
process.env.DATABASE_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
process.env.SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const { createClient } = require('@supabase/supabase-js')
const { Pool } = require('pg')

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 5000 })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30000)
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
      clearTimeout(timer)
      if (res.status === 429) { await sleep(5000 * (i + 1)); continue }
      if (!res.ok) return null
      const text = await res.text()
      if (text.startsWith('<')) return null
      return JSON.parse(text)
    } catch (e) { 
      console.log(`    fetch err (attempt ${i+1}): ${e.message}`)
      if (i < 2) await sleep(1000) 
    }
  }
  return null
}

const INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'
const YIELD_URL = 'https://api2.bybit.com/fapi/beehive/public/v2/leader/yield-trend'
const PERIODS = { '7D': 'DAY_CYCLE_TYPE_SEVEN_DAY', '30D': 'DAY_CYCLE_TYPE_THIRTY_DAY', '90D': 'DAY_CYCLE_TYPE_NINETY_DAY' }

;(async () => {
  console.log(`📊 Bybit PNL+Equity enrichment (limit=${LIMIT})`)
  
  const { rows } = await pool.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'bybit' AND pnl IS NULL 
      AND (source_trader_id LIKE '%==%' OR source_trader_id ~ '^\\d{9,}$')
    ORDER BY source_trader_id
    LIMIT $1
  `, [LIMIT])
  
  console.log(`Found ${rows.length} traders`)
  if (!rows.length) { await pool.end(); process.exit(0) }

  let pnlN = 0, equityN = 0, errors = 0, skipped = 0
  const now = new Date().toISOString()
  const startTime = Date.now()

  for (let i = 0; i < rows.length; i++) {
    const tid = rows[i].source_trader_id
    const enc = encodeURIComponent(tid)

    try {
      // Fetch income
      const json = await fetchJSON(`${INCOME_URL}?leaderMark=${enc}`)
      if (!json || json.retCode !== 0 || !json.result) { skipped++; await sleep(300); continue }
      
      const r = json.result
      const cumPnl = parseInt(r.cumYieldE8 || '0') / 1e8
      
      // Update PNL
      if (cumPnl !== 0) {
        const res = await pool.query(
          'UPDATE trader_snapshots SET pnl = $1 WHERE source = $2 AND source_trader_id = $3 AND pnl IS NULL',
          [cumPnl, 'bybit', tid]
        )
        if (res.rowCount > 0) pnlN++
      }
      await sleep(400)

      // Fetch equity curves for each period
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
          // Batch upsert via supabase
          for (let j = 0; j < points.length; j += 50) {
            const batch = points.slice(j, j + 50)
            const { error } = await sb.from('trader_equity_curve')
              .upsert(batch, { onConflict: 'source,source_trader_id,period,data_date' })
            if (error) { console.log(`  ⚠ eq: ${error.message}`); break }
          }
          equityN++
        }
        await sleep(350)
      }
    } catch (e) {
      errors++
      if (errors <= 5) console.log(`  ⚠ [${i+1}] ${tid}: ${e.message}`)
    }

    if ((i + 1) % 10 === 0 || i === rows.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${i+1}/${rows.length}] pnl=${pnlN} eq=${equityN} skip=${skipped} err=${errors} (${elapsed}s)`)
    }
  }

  console.log(`\n✅ Bybit done: PNL=${pnlN} equity=${equityN} skip=${skipped} err=${errors}`)
  await pool.end()
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })

#!/usr/bin/env node
/**
 * Enrich OKX Futures PNL + Equity via direct API (no puppeteer needed)
 */
process.env.DATABASE_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
process.env.SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const { createClient } = require('@supabase/supabase-js')
const { Pool } = require('pg')

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const BASE = 'https://www.okx.com/api/v5/copytrading'

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

;(async () => {
  console.log(`📊 OKX Futures PNL+Equity enrichment (limit=${LIMIT})`)
  
  const { rows } = await pool.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'okx_futures' AND pnl IS NULL
    LIMIT $1
  `, [LIMIT])
  
  console.log(`Found ${rows.length} traders with null PNL`)
  if (!rows.length) { await pool.end(); process.exit(0) }

  let pnlN = 0, equityN = 0, errors = 0, skipped = 0
  const now = new Date().toISOString()
  const startTime = Date.now()

  for (let i = 0; i < rows.length; i++) {
    const tid = rows[i].source_trader_id
    
    try {
      // Fetch trader detail
      const json = await fetchJSON(`${BASE}/public-lead-traders?instType=SWAP&uniqueCode=${encodeURIComponent(tid)}`)
      if (!json || json.code !== '0' || !json.data?.[0]?.ranks?.[0]) { skipped++; await sleep(300); continue }
      
      const detail = json.data[0].ranks[0]
      
      // PNL
      const pnl = parseFloat(detail.pnl || '0')
      if (pnl !== 0 && !isNaN(pnl)) {
        const res = await pool.query(
          'UPDATE trader_snapshots SET pnl = $1 WHERE source = $2 AND source_trader_id = $3 AND pnl IS NULL',
          [pnl, 'okx_futures', tid]
        )
        if (res.rowCount > 0) pnlN++
      }
      
      // Equity curve from pnlRatios
      if (detail.pnlRatios?.length > 0) {
        const baseDate = new Date()
        const points = detail.pnlRatios.map((val, idx) => ({
          source: 'okx_futures', source_trader_id: tid, period: '90D',
          data_date: new Date(baseDate - (detail.pnlRatios.length - 1 - idx) * 86400000).toISOString().split('T')[0],
          roi_pct: parseFloat(val) * 100,
          pnl_usd: null,
          captured_at: now,
        }))
        const { error } = await sb.from('trader_equity_curve')
          .upsert(points, { onConflict: 'source,source_trader_id,period,data_date' })
        if (!error) equityN++
      }
      
      // Also fetch weekly PNL for more granular equity data
      const weeklyJson = await fetchJSON(`${BASE}/public-weekly-pnl?instType=SWAP&uniqueCode=${encodeURIComponent(tid)}`)
      if (weeklyJson?.code === '0' && weeklyJson.data?.length > 0) {
        const points = weeklyJson.data.map(w => ({
          source: 'okx_futures', source_trader_id: tid, period: '90D',
          data_date: new Date(parseInt(w.beginTs || w.ts || Date.now())).toISOString().split('T')[0],
          roi_pct: null,
          pnl_usd: parseFloat(w.pnl || '0'),
          captured_at: now,
        })).filter(p => p.pnl_usd !== 0)
        
        if (points.length > 0) {
          await sb.from('trader_equity_curve')
            .upsert(points, { onConflict: 'source,source_trader_id,period,data_date' })
        }
      }
      
      await sleep(500)
    } catch (e) {
      errors++
      if (errors <= 3) console.log(`  ⚠ ${tid}: ${e.message}`)
    }

    if ((i + 1) % 20 === 0 || i === rows.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${i+1}/${rows.length}] pnl=${pnlN} eq=${equityN} skip=${skipped} err=${errors} (${elapsed}s)`)
    }
  }

  console.log(`\n✅ OKX done: PNL=${pnlN} equity=${equityN} skip=${skipped} err=${errors}`)
  await pool.end()
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })

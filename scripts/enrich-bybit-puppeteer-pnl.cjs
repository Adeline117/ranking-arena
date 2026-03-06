#!/usr/bin/env node
/**
 * Enrich Bybit PNL + Equity via Puppeteer (bypasses WAF)
 * Navigates to bybit.com, then uses page.evaluate to call APIs
 */
process.env.DATABASE_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
process.env.SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js')
const { Pool } = require('pg')

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')

const PERIODS = {
  '7D': 'DAY_CYCLE_TYPE_SEVEN_DAY',
  '30D': 'DAY_CYCLE_TYPE_THIRTY_DAY', 
  '90D': 'DAY_CYCLE_TYPE_NINETY_DAY'
}

;(async () => {
  console.log(`📊 Bybit PNL+Equity enrichment via Puppeteer (limit=${LIMIT})`)
  
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

  // Launch puppeteer with stealth
  const puppeteer = require('puppeteer-extra')
  const StealthPlugin = require('puppeteer-extra-plugin-stealth')
  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  console.log('🌐 Getting Bybit session...')
  await page.goto('https://www.bybit.com/copyTrade', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
  await sleep(5000)
  console.log('✅ Browser ready')

  let pnlN = 0, equityN = 0, errors = 0, skipped = 0
  const now = new Date().toISOString()
  const startTime = Date.now()

  for (let i = 0; i < rows.length; i++) {
    const tid = rows[i].source_trader_id
    const enc = encodeURIComponent(tid)

    try {
      // Fetch income via page.evaluate (bybit is slow, ~10s per request)
      const incomeResult = await Promise.race([
        page.evaluate(async (enc) => {
          try {
            const ctrl = new AbortController()
            setTimeout(() => ctrl.abort(), 25000)
            const r = await fetch(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${enc}`, { signal: ctrl.signal })
            return await r.json()
          } catch (e) { return { error: e.message } }
        }, enc),
        sleep(30000).then(() => ({ error: 'timeout' }))
      ])

      if (!incomeResult || incomeResult.error || incomeResult.retCode !== 0 || !incomeResult.result) {
        if (incomeResult?.error) console.log(`    ⏳ ${tid}: ${incomeResult.error}`)
        skipped++
        await sleep(300)
        continue
      }

      const r = incomeResult.result
      const cumPnl = parseInt(r.cumYieldE8 || '0') / 1e8

      if (cumPnl !== 0) {
        const res = await pool.query(
          'UPDATE trader_snapshots SET pnl = $1 WHERE source = $2 AND source_trader_id = $3 AND pnl IS NULL',
          [cumPnl, 'bybit', tid]
        )
        if (res.rowCount > 0) pnlN++
      }
      await sleep(400)

      // Fetch equity curves
      for (const [period, cycleType] of Object.entries(PERIODS)) {
        const yieldResult = await Promise.race([
          page.evaluate(async (enc, cycleType) => {
            try {
              const ctrl = new AbortController()
              setTimeout(() => ctrl.abort(), 25000)
              const r = await fetch(`https://api2.bybit.com/fapi/beehive/public/v2/leader/yield-trend?dayCycleType=${cycleType}&period=PERIOD_DAY&leaderMark=${enc}`, { signal: ctrl.signal })
              return await r.json()
            } catch (e) { return { error: e.message } }
          }, enc, cycleType),
          sleep(30000).then(() => ({ error: 'timeout' }))
        ])

        const trend = yieldResult?.result?.yieldTrend
        if (trend?.length > 0) {
          const points = trend.map(p => ({
            source: 'bybit', source_trader_id: tid, period,
            data_date: new Date(parseInt(p.statisticDate)).toISOString().split('T')[0],
            roi_pct: parseInt(p.cumResetRoiE4 || p.yieldRateE4 || '0') / 100,
            pnl_usd: parseInt(p.cumResetPnlE8 || p.yieldE8 || '0') / 1e8,
            captured_at: now,
          }))
          for (let j = 0; j < points.length; j += 50) {
            const { error } = await sb.from('trader_equity_curve')
              .upsert(points.slice(j, j + 50), { onConflict: 'source,source_trader_id,period,data_date' })
            if (error) { console.log(`  ⚠ eq: ${error.message}`); break }
          }
          equityN++
        }
        await sleep(300)
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
  await browser.close()
  await pool.end()
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })

#!/usr/bin/env node
/**
 * Enrich Bitget Futures PNL + Equity via Puppeteer
 * Strategy: Fetch traderList to get UID→nickname mapping, match DB, call cycleData
 */
// Set env vars before running: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL env var required')

const { createClient } = require('@supabase/supabase-js')
const { Pool } = require('pg')

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '300')
const SOURCE = 'bitget_futures'
const CYCLE_MAP = { '7D': 7, '30D': 30, '90D': 90 }
const normalizeNick = n => n.replace(/^@/, '').toLowerCase().trim()

;(async () => {
  console.log(`📊 Bitget Futures PNL+Equity enrichment (limit=${LIMIT})`)
  
  // Get traders with null PNL
  const { rows: nullPnl } = await pool.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = $1 AND pnl IS NULL
  `, [SOURCE])
  
  console.log(`${nullPnl.length} traders with null PNL`)
  if (!nullPnl.length) { await pool.end(); process.exit(0) }

  // Build lookup by normalized nickname
  const needsPnl = new Map() // normalized nick → source_trader_id
  for (const row of nullPnl) {
    needsPnl.set(normalizeNick(row.source_trader_id), row.source_trader_id)
  }

  const puppeteer = require('puppeteer-extra')
  const StealthPlugin = require('puppeteer-extra-plugin-stealth')
  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

  console.log('🌐 Getting Bitget CF clearance...')
  await page.goto('https://www.bitget.com/copy-trading/futures', { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  console.log('✅ Browser ready')

  // Step 1: Fetch traderList pages to build UID mapping
  console.log('\n📋 Fetching trader list to build UID mapping...')
  const matches = [] // {uid, dbId}
  let pageNo = 1
  const pageSize = 20
  
  // Try multiple sort options to get more traders
  for (const sort of [0, 1, 2, 3]) {
    pageNo = 1
    let hasMore = true
    
    while (hasMore && pageNo <= 100) {
      const result = await page.evaluate(async (pn, ps, s) => {
        try {
          const r = await fetch('/v1/trigger/trace/public/traderList', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ languageType: 0, sort: s, rule: 2, pageNo: pn, pageSize: ps }),
          })
          const text = await r.text()
          if (text.startsWith('<')) return null
          return JSON.parse(text)
        } catch { return null }
      }, pageNo, pageSize, sort)

      if (!result?.data?.rows?.length) { hasMore = false; break }

      for (const t of result.data.rows) {
        if (!t.traderUid || !t.traderNickName) continue
        const norm = normalizeNick(t.traderNickName)
        const dbId = needsPnl.get(norm)
        if (dbId && !matches.find(m => m.dbId === dbId)) {
          matches.push({ uid: t.traderUid, dbId })
        }
      }

      hasMore = result.data.nextFlag === true
      pageNo++
      await sleep(200 + Math.random() * 100)
      
      // Stop early if we've found enough
      if (matches.length >= LIMIT) break
    }
    
    console.log(`  Sort ${sort}: ${matches.length} matches so far`)
    if (matches.length >= LIMIT) break
  }

  console.log(`\n✅ Matched ${matches.length} traders with UIDs`)

  // Step 2: Fetch cycleData for each matched trader
  let pnlN = 0, equityN = 0, errors = 0
  const now = new Date().toISOString()
  const startTime = Date.now()
  const toProcess = matches.slice(0, LIMIT)

  for (let i = 0; i < toProcess.length; i++) {
    const { uid, dbId } = toProcess[i]
    
    try {
      // Use 90D for PNL (most comprehensive), but fetch all periods for equity
      for (const [period, cycleTime] of Object.entries(CYCLE_MAP)) {
        const result = await Promise.race([
          page.evaluate(async (triggerUid, ct) => {
            try {
              const r = await fetch('/v1/trigger/trace/public/cycleData', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ languageType: 0, triggerUserId: triggerUid, cycleTime: ct }),
              })
              const text = await r.text()
              if (text.startsWith('<')) return null
              return JSON.parse(text)
            } catch { return null }
          }, uid, cycleTime),
          sleep(15000).then(() => null)
        ])

        if (result?.code === '00000' && result.data) {
          const d = result.data
          
          // PNL from totalProfit (prefer longest period)
          if (period === '90D' && d.statisticsDTO?.totalProfit) {
            const pnl = parseFloat(d.statisticsDTO.totalProfit)
            if (!isNaN(pnl) && pnl !== 0) {
              const res = await pool.query(
                'UPDATE trader_snapshots SET pnl = $1 WHERE source = $2 AND source_trader_id = $3 AND pnl IS NULL',
                [pnl, SOURCE, dbId]
              )
              if (res.rowCount > 0) pnlN++
            }
          }

          // Equity curve
          if (d.roiRows?.rows?.length > 0) {
            const points = d.roiRows.rows.map(r => ({
              source: SOURCE, source_trader_id: dbId, period,
              data_date: new Date(r.dataTime).toISOString().split('T')[0],
              roi_pct: parseFloat(r.amount || '0'),
              pnl_usd: null,
              captured_at: now,
            }))
            const { error } = await sb.from('trader_equity_curve')
              .upsert(points, { onConflict: 'source,source_trader_id,period,data_date' })
            if (!error) equityN++
          }
        }
        
        await sleep(400 + Math.random() * 200)
      }
    } catch (e) {
      errors++
      if (errors <= 5) console.log(`  ⚠ ${dbId}: ${e.message}`)
    }

    if ((i + 1) % 10 === 0 || i === toProcess.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${i+1}/${toProcess.length}] pnl=${pnlN} eq=${equityN} err=${errors} (${elapsed}s)`)
    }
  }

  console.log(`\n✅ Bitget done: PNL=${pnlN} equity=${equityN} err=${errors}`)
  console.log(`   (${nullPnl.length - matches.length} traders couldn't be matched to UIDs)`)
  await browser.close()
  await pool.end()
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })

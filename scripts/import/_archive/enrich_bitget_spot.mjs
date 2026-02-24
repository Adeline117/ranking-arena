#!/usr/bin/env node
/**
 * Bitget Spot WR/TC Enrichment
 * 
 * Uses Puppeteer to get CF cookies, then uses node fetch with those cookies.
 */
import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'

puppeteer.use(StealthPlugin())

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const db = new pg.Client(DB_URL)
  await db.connect()

  const { rows: traders } = await db.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source='bitget_spot' AND (win_rate IS NULL OR trades_count IS NULL)
  `)
  console.log(`Found ${traders.length} bitget_spot traders missing WR/TC`)
  if (traders.length === 0) { await db.end(); return }

  // Get CF cookies via browser
  console.log('🌐 Getting CF cookies...')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
  await sleep(5000)

  const cookies = await page.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  const ua = await page.evaluate(() => navigator.userAgent)
  console.log(`✅ Got ${cookies.length} cookies`)

  // Test with node fetch
  const testTid = traders[0].source_trader_id
  console.log(`Testing fetch for ${testTid}...`)
  
  const testResp = await fetch('https://www.bitget.com/v1/trigger/trace/public/cycleData', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieStr,
      'User-Agent': ua,
      'Origin': 'https://www.bitget.com',
      'Referer': 'https://www.bitget.com/copy-trading',
    },
    body: JSON.stringify({ languageType: 0, triggerUserId: testTid, cycleTime: 90 }),
    signal: AbortSignal.timeout(10000),
  })
  const testText = await testResp.text()
  console.log(`Test result: ${testText.substring(0, 200)}`)

  const testOk = testText.includes('"00000"')
  
  if (!testOk) {
    // Fallback: use page.evaluate but with proper timeout
    console.log('⚠️ Node fetch failed CF, falling back to browser evaluate...')
    await enrichViaBrowser(page, traders, db)
  } else {
    console.log('✅ Node fetch works! Using fast mode.')
    await browser.close()
    await enrichViaFetch(traders, db, cookieStr, ua)
  }

  const { rows: [v] } = await db.query(`
    SELECT count(*) as total, count(win_rate) as has_wr, count(trades_count) as has_tc 
    FROM trader_snapshots WHERE source='bitget_spot'
  `)
  console.log(`\n📊 bitget_spot: WR ${v.has_wr}/${v.total} (${(v.has_wr/v.total*100).toFixed(1)}%), TC ${v.has_tc}/${v.total} (${(v.has_tc/v.total*100).toFixed(1)}%)`)
  await db.end()
}

async function enrichViaFetch(traders, db, cookieStr, ua) {
  let updated = 0, errors = 0
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': cookieStr,
    'User-Agent': ua,
    'Origin': 'https://www.bitget.com',
    'Referer': 'https://www.bitget.com/copy-trading',
  }

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i].source_trader_id
    try {
      const resp = await fetch('https://www.bitget.com/v1/trigger/trace/public/cycleData', {
        method: 'POST', headers,
        body: JSON.stringify({ languageType: 0, triggerUserId: tid, cycleTime: 90 }),
        signal: AbortSignal.timeout(8000),
      })
      const result = await resp.json()

      if (result?.code === '00000' && result.data?.statisticsDTO) {
        const stats = result.data.statisticsDTO
        const tc = parseInt(stats.totalTrades || '0') || null
        const wr = parseFloat(stats.winningRate || '0')
        const wrVal = isNaN(wr) ? null : wr
        if (tc || wrVal !== null) {
          const { rowCount } = await db.query(
            `UPDATE trader_snapshots 
             SET trades_count = COALESCE($1, trades_count), win_rate = COALESCE($2::text, win_rate)
             WHERE source='bitget_spot' AND source_trader_id=$3 AND (trades_count IS NULL OR win_rate IS NULL)`,
            [tc, wrVal, tid]
          )
          updated += rowCount
        }
      } else { errors++ }
    } catch { errors++ }

    if ((i + 1) % 50 === 0 || i === traders.length - 1)
      console.log(`  [${i + 1}/${traders.length}] updated=${updated} errors=${errors}`)
    await sleep(300 + Math.random() * 200)
  }
  console.log(`✅ Done. Updated ${updated} rows, ${errors} errors`)
}

async function enrichViaBrowser(page, traders, db) {
  let updated = 0, errors = 0

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i].source_trader_id
    try {
      // Set a page-level timeout by navigating if stuck
      const evalPromise = page.evaluate(async (uid) => {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8000)
        try {
          const r = await fetch('/v1/trigger/trace/public/cycleData', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: 90 }),
            signal: ctrl.signal,
          })
          clearTimeout(timer)
          const text = await r.text()
          try { return JSON.parse(text) } catch { return { parseError: true } }
        } catch (e) { clearTimeout(timer); return { fetchError: e.message } }
      }, tid)

      const timeout = sleep(15000).then(() => 'TIMEOUT')
      const result = await Promise.race([evalPromise, timeout])

      if (result === 'TIMEOUT') {
        errors++
        // Reload page to unstick
        await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
        await sleep(3000)
        continue
      }

      if (result?.code === '00000' && result.data?.statisticsDTO) {
        const stats = result.data.statisticsDTO
        const tc = parseInt(stats.totalTrades || '0') || null
        const wr = parseFloat(stats.winningRate || '0')
        const wrVal = isNaN(wr) ? null : wr
        if (tc || wrVal !== null) {
          const { rowCount } = await db.query(
            `UPDATE trader_snapshots 
             SET trades_count = COALESCE($1, trades_count), win_rate = COALESCE($2::text, win_rate)
             WHERE source='bitget_spot' AND source_trader_id=$3 AND (trades_count IS NULL OR win_rate IS NULL)`,
            [tc, wrVal, tid]
          )
          updated += rowCount
        }
      } else { errors++ }
    } catch { errors++ }

    if ((i + 1) % 20 === 0 || i === traders.length - 1)
      console.log(`  [${i + 1}/${traders.length}] updated=${updated} errors=${errors}`)
    await sleep(500 + Math.random() * 300)
  }
  console.log(`✅ Done. Updated ${updated} rows, ${errors} errors`)
}

main().catch(e => { console.error(e); process.exit(1) })

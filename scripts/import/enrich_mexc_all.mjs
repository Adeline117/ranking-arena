#!/usr/bin/env node
import puppeteer from 'puppeteer'
import pg from 'pg'
import fs from 'fs'

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const CACHE_FILE = '/tmp/mexc_traders_cache.json'

async function launchBrowser() {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions']
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  // Block images/css to avoid crashes
  await page.setRequestInterception(true)
  page.on('request', req => {
    const type = req.resourceType()
    if (['image', 'stylesheet', 'font', 'media'].includes(type)) req.abort()
    else req.continue()
  })
  console.log('🌐 Loading MEXC...')
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  return { browser, page }
}

async function fetchPage(page, pageNum, orderBy) {
  try {
    return await page.evaluate(async (pg, ob) => {
      const resp = await fetch(`https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=30&orderBy=${ob}&page=${pg}`)
      return (await resp.json())?.data?.content || []
    }, pageNum, orderBy)
  } catch (e) {
    return null // signal browser crashed
  }
}

async function main() {
  const pool = new pg.Pool({ connectionString: DB_URL })

  const { rows: beforeStats } = await pool.query(`
    SELECT season_id, COUNT(*) as total,
      COUNT(win_rate) as has_wr, COUNT(max_drawdown) as has_mdd, COUNT(trades_count) as has_tc
    FROM trader_snapshots WHERE source='mexc' GROUP BY season_id ORDER BY season_id
  `)
  console.log('📊 BEFORE:')
  for (const r of beforeStats) console.log(`  ${r.season_id}: ${r.total} | WR=${r.has_wr} MDD=${r.has_mdd} TC=${r.has_tc}`)

  let apiTraders = new Map()
  
  if (fs.existsSync(CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    apiTraders = new Map(Object.entries(cached))
    console.log(`\n📦 Cache: ${apiTraders.size} traders`)
  } else {
    let { browser, page } = await launchBrowser()

    for (const orderBy of ['COMPREHENSIVE', 'FOLLOWERS', 'ROI']) {
      let pageNum = 1, staleCount = 0
      console.log(`\n📡 ${orderBy}...`)
      
      while (pageNum <= 100) {
        let items = await fetchPage(page, pageNum, orderBy)
        
        // If null, browser crashed - relaunch
        if (items === null) {
          console.log('  ⚠️ Browser crashed, relaunching...')
          await browser.close().catch(() => {})
          ;({ browser, page } = await launchBrowser())
          items = await fetchPage(page, pageNum, orderBy)
          if (items === null) { console.log('  ❌ Failed after relaunch'); break }
        }
        
        if (items.length === 0) break
        const prev = apiTraders.size
        for (const t of items) {
          const nick = (t.nickname || t.nickName || '').toLowerCase().trim()
          if (nick && !apiTraders.has(nick)) apiTraders.set(nick, t)
        }
        if (apiTraders.size === prev) { staleCount++; if (staleCount >= 3) break } else staleCount = 0
        if (pageNum % 20 === 0) console.log(`  p${pageNum}: ${apiTraders.size}`)
        pageNum++
        await sleep(200)
      }
      console.log(`  ${apiTraders.size} unique`)
    }
    await browser.close().catch(() => {})

    // Cache
    const obj = {}
    for (const [k, v] of apiTraders) obj[k] = v
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj))
    console.log(`\n💾 Cached ${apiTraders.size}`)
  }

  console.log(`\n📊 API: ${apiTraders.size} traders`)

  // Update DB
  function normalizeWR(val) {
    if (val == null) return null
    val = Number(val)
    if (isNaN(val)) return null
    return Math.abs(val) <= 1 && val !== 0 ? val * 100 : val
  }

  let totalUpdated = 0
  for (const season of ['7D', '30D', '90D']) {
    const { rows: missing } = await pool.query(`
      SELECT source_trader_id, win_rate, max_drawdown, trades_count 
      FROM trader_snapshots WHERE source='mexc' AND season_id=$1 
      AND (win_rate IS NULL OR max_drawdown IS NULL OR trades_count IS NULL)
    `, [season])

    let updated = 0
    for (const row of missing) {
      const t = apiTraders.get(row.source_trader_id.toLowerCase().trim())
      if (!t) continue

      const wr = row.win_rate != null ? null : normalizeWR(t.winRate)
      const mdd = row.max_drawdown != null ? null : (t.maxDrawdown7 != null ? Number(t.maxDrawdown7) * 100 : null)
      const tc = row.trades_count != null ? null : (t.openTimes != null ? Number(t.openTimes) : null)
      if (wr == null && mdd == null && tc == null) continue

      const sets = [], vals = []
      let idx = 1
      if (wr != null) { sets.push(`win_rate = $${idx++}`); vals.push(wr) }
      if (mdd != null) { sets.push(`max_drawdown = $${idx++}`); vals.push(mdd) }
      if (tc != null) { sets.push(`trades_count = $${idx++}`); vals.push(tc) }
      vals.push(season, row.source_trader_id)
      const r = await pool.query(`UPDATE trader_snapshots SET ${sets.join(', ')} WHERE source='mexc' AND season_id=$${idx++} AND source_trader_id=$${idx}`, vals)
      if (r.rowCount > 0) updated++
    }
    console.log(`✅ ${season}: ${updated}/${missing.length}`)
    totalUpdated += updated
  }

  // Fill delisted traders
  const { rowCount: tcF } = await pool.query(`UPDATE trader_snapshots SET trades_count = 0 WHERE source='mexc' AND trades_count IS NULL`)
  const { rowCount: wrF } = await pool.query(`UPDATE trader_snapshots SET win_rate = 0 WHERE source='mexc' AND win_rate IS NULL`)
  const { rowCount: mddF } = await pool.query(`UPDATE trader_snapshots SET max_drawdown = 0 WHERE source='mexc' AND max_drawdown IS NULL`)
  console.log(`\n🔧 Filled delisted: WR=${wrF} MDD=${mddF} TC=${tcF}`)

  const { rows: afterStats } = await pool.query(`
    SELECT season_id, COUNT(*) as total,
      COUNT(win_rate) as has_wr, COUNT(max_drawdown) as has_mdd, COUNT(trades_count) as has_tc
    FROM trader_snapshots WHERE source='mexc' GROUP BY season_id ORDER BY season_id
  `)
  console.log('\n📊 AFTER:')
  for (const r of afterStats) console.log(`  ${r.season_id}: ${r.total} | WR=${r.has_wr} MDD=${r.has_mdd} TC=${r.has_tc}`)
  console.log('\n📈 DELTA:')
  for (const a of afterStats) {
    const b = beforeStats.find(x => x.season_id === a.season_id)
    if (b) console.log(`  ${a.season_id}: WR+${a.has_wr-b.has_wr} MDD+${a.has_mdd-b.has_mdd} TC+${a.has_tc-b.has_tc} → ${((a.has_wr/a.total)*100).toFixed(0)}%/${((a.has_mdd/a.total)*100).toFixed(0)}%/${((a.has_tc/a.total)*100).toFixed(0)}%`)
  }

  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })

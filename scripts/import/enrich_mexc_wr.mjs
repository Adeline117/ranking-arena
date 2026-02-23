#!/usr/bin/env node
/**
 * Enrich MEXC traders with WR/MDD data by calling the v2 API via Puppeteer.
 */
import puppeteer from 'puppeteer'
import pg from 'pg'

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const pool = new pg.Pool({ connectionString: DB_URL })
  
  // Get current stats
  const { rows: [before] } = await pool.query(
    `SELECT COUNT(*) as total, COUNT(win_rate) as has_wr 
     FROM trader_snapshots WHERE source='mexc' AND season_id='90D'`
  )
  console.log(`📊 Before: ${before.has_wr}/${before.total} have WR`)

  // Get all text-ID traders missing WR
  const { rows: missing } = await pool.query(
    `SELECT source_trader_id FROM trader_snapshots 
     WHERE source='mexc' AND season_id='90D' AND win_rate IS NULL`
  )
  const missingSet = new Map()
  for (const r of missing) {
    missingSet.set(r.source_trader_id.toLowerCase().trim(), r.source_trader_id)
  }
  console.log(`🔍 Missing WR: ${missing.length} traders`)

  // Launch Puppeteer, load the page first to establish cookies/session
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  console.log('🌐 Loading MEXC page to establish session...')
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
  await sleep(5000)

  // Now call the API from within the browser context to paginate
  const apiTraders = new Map()
  let pageNum = 1
  let hasMore = true
  const LIMIT = 30

  // Try different orderBy values to get more traders
  const orderBys = ['COMPREHENSIVE', 'FOLLOWERS', 'ROI']
  
  for (const orderBy of orderBys) {
    pageNum = 1
    hasMore = true
    let staleCount = 0
    
    console.log(`\n📡 Fetching with orderBy=${orderBy}...`)
    
    while (hasMore && pageNum <= 100) {
      const result = await page.evaluate(async (pg, lim, ob) => {
        try {
          const url = `https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2?condition=%5B%5D&limit=${lim}&orderBy=${ob}&page=${pg}`
          const resp = await fetch(url)
          const data = await resp.json()
          const list = data?.data?.content || []
          const totalElements = data?.data?.totalElements ?? data?.data?.total ?? 0
          const totalPages = data?.data?.totalPages ?? (totalElements > 0 ? Math.ceil(totalElements / lim) : 0)
          return { 
            items: list.map(i => ({
              nickname: i.nickname || i.nickName,
              winRate: i.winRate,
              maxDrawdown: i.maxDrawdown7 ?? i.maxDrawdown ?? null,
              uid: i.uid
            })),
            totalPages,
            totalElements
          }
        } catch (e) {
          return { items: [], error: e.message }
        }
      }, pageNum, LIMIT, orderBy)

      if (result.error || result.items.length === 0) {
        hasMore = false
        break
      }

      if (pageNum === 1) {
        console.log(`  Total elements: ${result.totalElements}, pages: ${result.totalPages}`)
      }

      const prevSize = apiTraders.size
      for (const t of result.items) {
        if (!t.nickname) continue
        const key = t.nickname.toLowerCase().trim()
        if (!apiTraders.has(key)) {
          apiTraders.set(key, {
            nickname: t.nickname,
            winRate: t.winRate != null ? (Math.abs(t.winRate) <= 1 ? t.winRate * 100 : t.winRate) : null,
            maxDrawdown: t.maxDrawdown,
            uid: t.uid
          })
        }
      }

      if (pageNum % 10 === 0) {
        console.log(`  Page ${pageNum}: ${result.items.length} items, total unique: ${apiTraders.size}`)
      }

      if (apiTraders.size === prevSize) {
        staleCount++
        if (staleCount >= 3) break
      } else {
        staleCount = 0
      }

      pageNum++
      if (result.totalPages && pageNum > result.totalPages) break
      await sleep(300) // rate limit
    }
  }

  await browser.close()
  console.log(`\n📊 Total API traders collected: ${apiTraders.size}`)

  // Match and update
  let matched = 0
  let updated = 0

  for (const [key, original] of missingSet) {
    const apiData = apiTraders.get(key)
    if (apiData && apiData.winRate !== null) {
      matched++
      try {
        const result = await pool.query(
          `UPDATE trader_snapshots SET win_rate = $1, max_drawdown = $2 
           WHERE source='mexc' AND season_id='90D' AND source_trader_id = $3 AND win_rate IS NULL`,
          [apiData.winRate, apiData.maxDrawdown, original]
        )
        if (result.rowCount > 0) updated++
      } catch (e) {
        console.error(`  ❌ ${original}: ${e.message}`)
      }
    }
  }

  console.log(`🔗 Matched: ${matched}, Updated: ${updated}`)

  // Verify
  const { rows: [after] } = await pool.query(
    `SELECT COUNT(*) as total, COUNT(win_rate) as has_wr 
     FROM trader_snapshots WHERE source='mexc' AND season_id='90D'`
  )
  console.log(`📊 After: ${after.has_wr}/${after.total} have WR (was ${before.has_wr}/${before.total})`)
  console.log(`✅ Net gain: +${after.has_wr - before.has_wr} traders with WR`)

  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })

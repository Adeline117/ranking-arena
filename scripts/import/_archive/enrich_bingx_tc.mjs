#!/usr/bin/env node
/**
 * BingX Trade Count Enrichment
 * 
 * Paginates the recommend endpoint to get totalTransactions for each trader,
 * then updates trader_snapshots.trades_count.
 */
import { chromium } from 'playwright'
import pg from 'pg'
import { sleep } from '../lib/shared.mjs'

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const PROXY = 'http://127.0.0.1:7890'
const API_BASE = 'https://api-app.qq-os.com'
const RECOMMEND_PATH = '/api/copy-trade-facade/v2/trader/new/recommend'
const PAGE_SIZE = 50

async function main() {
  const db = new pg.Client(DB_URL)
  await db.connect()

  // Launch browser to get signed headers
  console.log('🚀 Launching browser...')
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY } })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }, locale: 'en-US',
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await context.newPage()
  let capturedHeaders = null

  page.on('request', req => {
    if (req.url().includes('recommend') && req.method() === 'POST' && !capturedHeaders) {
      capturedHeaders = { ...req.headers() }
      capturedHeaders['referer'] = 'https://bingx.com/'
      capturedHeaders['origin'] = 'https://bingx.com'
      console.log('  ✅ Captured API headers')
    }
  })

  await page.goto('https://bingx.com/en/copytrading/', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(15000)

  if (!capturedHeaders) {
    for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollBy(0, 500)); await sleep(2000) }
  }
  if (!capturedHeaders) {
    console.error('❌ Failed to capture headers'); await browser.close(); await db.end(); process.exit(1)
  }

  // Paginate through all traders
  console.log('\n📡 Paginating recommend endpoint...')
  const traderTC = new Map() // uid -> totalTransactions
  let pageId = 0, total = 0

  while (true) {
    const url = `${API_BASE}${RECOMMEND_PATH}?pageId=${pageId}&pageSize=${PAGE_SIZE}`
    try {
      const resp = await page.evaluate(async ({ url, headers }) => {
        const r = await fetch(url, { method: 'POST', headers, credentials: 'include' })
        return await r.json()
      }, { url, headers: capturedHeaders })

      if (resp.code !== 0) {
        capturedHeaders.timestamp = String(Date.now())
        const retry = await page.evaluate(async ({ url, headers }) => {
          const r = await fetch(url, { method: 'POST', headers, credentials: 'include' })
          return await r.json()
        }, { url, headers: capturedHeaders })
        if (retry.code !== 0) { console.log(`  ❌ Page ${pageId} failed`); break }
        Object.assign(resp, retry)
      }

      const results = resp.data?.result || []
      total = resp.data?.total || total
      if (results.length === 0) break

      for (const item of results) {
        const uid = String(item.trader?.uid || '')
        const tc = parseInt(item.rankStat?.totalTransactions) || null
        if (uid && tc !== null) traderTC.set(uid, tc)
      }

      console.log(`  Page ${pageId}: +${results.length} (${traderTC.size} with TC / total ${total})`)
      if (traderTC.size >= total) break
      pageId++
      await sleep(800 + Math.random() * 500)
    } catch (e) {
      console.error(`  ❌ Page ${pageId}: ${e.message}`); break
    }
  }

  await browser.close()
  console.log(`\n📊 Got trade counts for ${traderTC.size} traders`)

  // Update DB
  let updated = 0
  for (const [uid, tc] of traderTC) {
    const { rowCount } = await db.query(
      `UPDATE trader_snapshots SET trades_count = $1 WHERE source = 'bingx' AND source_trader_id = $2 AND trades_count IS NULL`,
      [tc, uid]
    )
    updated += rowCount
  }

  console.log(`✅ Updated ${updated} snapshot rows`)

  // Verify
  const { rows: [verify] } = await db.query(`
    SELECT count(*) as total, count(trades_count) as has_tc 
    FROM trader_snapshots WHERE source='bingx'
  `)
  console.log(`📊 BingX snapshots: ${verify.has_tc}/${verify.total} have trades_count (${(verify.has_tc/verify.total*100).toFixed(1)}%)`)

  await db.end()
}

main().catch(e => { console.error(e); process.exit(1) })

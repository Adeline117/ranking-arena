#!/usr/bin/env node
/**
 * BingX Enrichment via Playwright
 * 
 * Opens BingX copy trading page, intercepts API responses to collect
 * win_rate, max_drawdown, trades_count, then updates DB.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseTraderData(item) {
  const uid = String(item.trader?.uid || item.uniqueId || item.uid || item.traderId || item.id || '')
  if (!uid) return null
  const stat = item.rankStat || item
  return {
    uid,
    tc: stat.totalTransactions ? parseInt(stat.totalTransactions) : null,
    wr: stat.winRate != null ? parseFloat(stat.winRate) : null,
    mdd: stat.maxDrawdown != null ? parseFloat(stat.maxDrawdown) : null,
    pnl: stat.pnl != null ? parseFloat(stat.pnl) : null,
  }
}

async function main() {
  console.log('🚀 BingX Browser Enrichment\n')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await context.newPage()
  const capturedData = new Map()
  let capturedHeaders = null

  // Intercept ALL responses for trader data
  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('recommend') && !url.includes('ranking') && !url.includes('topRanking') && !url.includes('trader')) return
    try {
      const text = await resp.text()
      if (!text.startsWith('{')) return
      const data = JSON.parse(text)
      
      // Extract items from various response shapes
      const items = data?.data?.result || data?.data?.list || data?.data?.rows || data?.data?.records || []
      if (!Array.isArray(items)) return
      
      for (const item of items) {
        const parsed = parseTraderData(item)
        if (parsed) capturedData.set(parsed.uid, parsed)
      }
    } catch { /* not JSON */ }
  })

  page.on('request', req => {
    if (!capturedHeaders && req.url().includes('recommend') && req.method() === 'POST') {
      capturedHeaders = Object.fromEntries(
        Object.entries(req.headers()).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))
      )
      console.log('  ✅ Captured request headers')
    }
  })

  // ── Load main page ──
  console.log('🌐 Opening BingX copy trading...')
  await page.goto('https://bingx.com/en/copytrading/', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(8000)
  console.log(`  After load: ${capturedData.size} traders`)

  // ── Scroll to load more ──
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 800))
    await sleep(2000)
  }
  console.log(`  After scrolling: ${capturedData.size} traders`)

  // ── Try clicking "Load More" or pagination ──
  try {
    const loadMoreBtns = await page.$$('button:has-text("Load More"), button:has-text("View More"), [class*="loadMore"], [class*="pagination"] button')
    for (const btn of loadMoreBtns) {
      try { await btn.click(); await sleep(3000) } catch {}
    }
  } catch {}
  console.log(`  After load-more: ${capturedData.size} traders`)

  // ── Use captured headers to paginate recommend API from within page ──
  if (capturedHeaders && capturedData.size < 500) {
    console.log('\n📡 Paginating recommend API via page.evaluate...')
    for (let pageId = 0; pageId < 30; pageId++) {
      try {
        const result = await page.evaluate(async ({ pageId, headers }) => {
          try {
            const r = await fetch(
              `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${pageId}&pageSize=50`,
              { method: 'POST', headers }
            )
            return await r.json()
          } catch (e) { return { error: e.message } }
        }, { pageId, headers: capturedHeaders })

        if (result?.error || result?.code !== 0) {
          // Try without custom headers, just credentials
          const result2 = await page.evaluate(async (pageId) => {
            try {
              const r = await fetch(
                `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${pageId}&pageSize=50`,
                { method: 'POST' }
              )
              return await r.json()
            } catch (e) { return { error: e.message } }
          }, pageId)
          
          if (result2?.code !== 0) {
            if (pageId === 0) console.log(`  Recommend API failed: code=${result?.code || result2?.code}`)
            break
          }
          
          const items2 = result2?.data?.result || []
          for (const item of items2) {
            const parsed = parseTraderData(item)
            if (parsed) capturedData.set(parsed.uid, parsed)
          }
        } else {
          const items = result?.data?.result || []
          if (!items.length) break
          for (const item of items) {
            const parsed = parseTraderData(item)
            if (parsed) capturedData.set(parsed.uid, parsed)
          }
        }

        if (pageId % 5 === 0) console.log(`  Page ${pageId}: ${capturedData.size} total`)
        await sleep(800)
      } catch (e) {
        console.log(`  Page ${pageId} error: ${e.message}`)
        break
      }
    }
  }

  // ── Navigate to leaderboard page for more data ──
  if (capturedData.size < 100) {
    console.log('\n🌐 Trying leaderboard page...')
    await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', { timeout: 60000, waitUntil: 'domcontentloaded' })
    await sleep(10000)
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await sleep(2000)
    }
    console.log(`  After leaderboard: ${capturedData.size} traders`)
  }

  // ── Try individual trader details via browser context ──
  const { data: needRows } = await sb
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', 'bingx')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
  
  const remaining = [...new Set((needRows || []).map(r => r.source_trader_id))]
    .filter(uid => !capturedData.has(uid))
  
  if (remaining.length > 0) {
    console.log(`\n📡 Fetching ${Math.min(remaining.length, 100)} individual trader pages...`)
    let fetched = 0
    const toFetch = remaining.slice(0, 100)
    
    for (let i = 0; i < toFetch.length; i++) {
      const uid = toFetch[i]
      try {
        // Navigate to trader detail page and intercept API calls
        const detailPage = await context.newPage()
        let traderDetail = null
        
        detailPage.on('response', async resp => {
          if (traderDetail) return
          const url = resp.url()
          if (!url.includes('trader') || !url.includes(uid)) return
          try {
            const data = await resp.json()
            if (data?.code === 0 && data?.data) {
              const d = data.data
              traderDetail = {
                uid,
                wr: d.winRate != null ? parseFloat(d.winRate) : null,
                mdd: d.maxDrawdown != null ? parseFloat(d.maxDrawdown) : null,
                tc: d.totalTransactions != null ? parseInt(d.totalTransactions) : null,
                pnl: d.pnl != null ? parseFloat(d.pnl) : null,
              }
            }
          } catch {}
        })
        
        await detailPage.goto(`https://bingx.com/en/CopyTrading/tradeDetail/${uid}`, { 
          timeout: 20000, waitUntil: 'domcontentloaded' 
        })
        await sleep(5000)
        
        if (traderDetail && (traderDetail.wr != null || traderDetail.mdd != null || traderDetail.tc != null)) {
          capturedData.set(uid, traderDetail)
          fetched++
        }
        
        await detailPage.close()
        if ((i + 1) % 10 === 0) console.log(`  [${i + 1}/${toFetch.length}] fetched=${fetched}`)
        await sleep(1000)
      } catch {
        // Close any hanging pages
        try { const pages = context.pages(); if (pages.length > 1) await pages[pages.length - 1].close() } catch {}
      }
    }
    console.log(`  Individual: ${fetched}/${toFetch.length}`)
  }

  await browser.close()
  console.log(`\n📊 Total enrichment data: ${capturedData.size} traders`)

  if (capturedData.size === 0) {
    console.error('❌ No data captured.')
    process.exit(1)
  }

  // ── Normalize and update DB ──
  function normalizeWR(wr) {
    if (wr == null) return null
    if (wr > 0 && wr <= 1) return wr * 100
    return wr
  }
  function normalizeMDD(mdd) {
    if (mdd == null) return null
    const val = Math.abs(mdd)
    if (val > 0 && val <= 1) return val * 100
    return val
  }

  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    console.log(`\n📝 Updating ${table}...`)
    const { data: rows, error } = await sb
      .from(table)
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count, pnl')
      .eq('source', 'bingx')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

    if (error) { console.error(`  Error:`, error.message); continue }
    
    let updated = 0
    for (const row of rows) {
      const d = capturedData.get(row.source_trader_id)
      if (!d) continue
      
      const updates = {}
      if (row.win_rate == null && d.wr != null) updates.win_rate = normalizeWR(d.wr)
      if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = normalizeMDD(d.mdd)
      if (row.trades_count == null && d.tc != null) updates.trades_count = d.tc
      if (row.pnl == null && d.pnl != null) updates.pnl = d.pnl
      
      if (!Object.keys(updates).length) continue
      const { error: ue } = await sb.from(table).update(updates).eq('id', row.id)
      if (!ue) updated++
    }
    console.log(`  Updated ${updated}/${rows.length} rows`)
  }

  // ── Verify ──
  console.log('\n📊 Verification:')
  for (const table of ['trader_snapshots', 'leaderboard_ranks']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx')
    const { count: noWR } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('win_rate', null)
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', 'bingx').is('trades_count', null)
    console.log(`  ${table} (${total}):`)
    console.log(`    win_rate:     ${total - noWR}/${total} (${noWR} null)`)
    console.log(`    max_drawdown: ${total - noMDD}/${total} (${noMDD} null)`)
    console.log(`    trades_count: ${total - noTC}/${total} (${noTC} null)`)
  }
  
  console.log('\n✅ Done!')
}

main().catch(e => { console.error(e); process.exit(1) })

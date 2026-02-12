/**
 * Browser-based enrichment for leaderboard_ranks
 * Handles Cloudflare-protected APIs: BingX, Bitget Futures, Weex
 * 
 * Usage: node scripts/import/enrich_lr_browser.mjs <platform>
 * Platforms: bingx, bitget_futures, weex
 */
import { chromium } from 'playwright'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const sb = getSupabaseClient()
const platform = process.argv[2]
if (!['bingx', 'bitget_futures', 'weex'].includes(platform)) {
  console.error('Usage: node enrich_lr_browser.mjs <bingx|bitget_futures|weex>')
  process.exit(1)
}

const CONFIGS = {
  bingx: {
    startUrl: 'https://bingx.com/en/copytrading/',
    waitMs: 15000,
  },
  bitget_futures: {
    startUrl: 'https://www.bitget.com/copy-trading',
    waitMs: 8000,
  },
  weex: {
    startUrl: 'https://www.weex.com/copy-trading',
    waitMs: 12000,
  },
}

async function enrichBingX(page, rows) {
  console.log(`\n📡 BingX: enriching ${rows.length} traders via intercepted API...`)
  
  // Capture headers from the page's API calls
  let capturedHeaders = null
  page.on('request', req => {
    if (req.url().includes('recommend') && req.method() === 'POST' && !capturedHeaders) {
      capturedHeaders = { ...req.headers() }
      console.log('  ✅ Captured BingX API headers')
    }
  })
  
  // Trigger API calls by scrolling
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 500))
    await sleep(2000)
  }
  
  if (!capturedHeaders) {
    console.log('  ❌ Failed to capture BingX headers')
    return 0
  }

  // Paginate recommend API
  const enrichMap = new Map()
  for (let pageId = 0; pageId < 20; pageId++) {
    try {
      const url = `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${pageId}&pageSize=50`
      const resp = await page.evaluate(async ({ url, headers }) => {
        const r = await fetch(url, { method: 'POST', headers, credentials: 'include' })
        return await r.json()
      }, { url, headers: capturedHeaders })
      
      if (resp.code !== 0) break
      const items = resp.data?.result || []
      if (!items.length) break
      
      for (const item of items) {
        const uid = String(item.trader?.uid || '')
        if (!uid) continue
        const stat = item.rankStat || {}
        enrichMap.set(uid, {
          tc: stat.totalTransactions ? parseInt(stat.totalTransactions) : null,
          wr: stat.winRate != null ? parseFloat(stat.winRate) : null,
          mdd: stat.maxDrawdown != null ? parseFloat(stat.maxDrawdown) : null,
        })
      }
      console.log(`  Page ${pageId}: ${items.length} traders (total: ${enrichMap.size})`)
      await sleep(800)
    } catch (e) { console.log(`  Page ${pageId} error: ${e.message}`); break }
  }

  // Try individual detail for remaining via page context
  const remaining = rows.filter(r => !enrichMap.has(r.source_trader_id))
  if (remaining.length > 0 && remaining.length <= 50) {
    console.log(`  Fetching ${remaining.length} individual details...`)
    for (const row of remaining) {
      try {
        const resp = await page.evaluate(async (uid) => {
          const r = await fetch(`/api/copytrading/v1/trader/detail?uid=${uid}&timeType=3`)
          return await r.json()
        }, row.source_trader_id)
        if (resp?.code === 0 && resp.data) {
          const d = resp.data
          enrichMap.set(row.source_trader_id, {
            wr: d.winRate != null ? parseFloat(d.winRate) : null,
            mdd: d.maxDrawdown != null ? parseFloat(d.maxDrawdown) : null,
            tc: d.totalTransactions != null ? parseInt(d.totalTransactions) : null,
          })
        }
      } catch {}
      await sleep(300)
    }
  }

  // Update DB
  let updated = 0
  for (const row of rows) {
    const d = enrichMap.get(row.source_trader_id)
    if (!d) continue
    const updates = {}
    if (row.win_rate === null && d.wr != null) updates.win_rate = d.wr
    if (row.max_drawdown === null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.trades_count === null && d.tc != null) updates.trades_count = d.tc
    if (!Object.keys(updates).length) continue
    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) updated++
  }
  return updated
}

async function enrichBitgetFutures(page, rows) {
  console.log(`\n📡 Bitget Futures: enriching ${rows.length} traders via cycleData API...`)
  
  // Dismiss popups
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach(btn => {
      if (/OK|Got|Accept/i.test(btn.textContent)) try { btn.click() } catch {}
    })
  }).catch(() => {})
  await sleep(1000)

  let updated = 0, blocked = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const result = await Promise.race([
        page.evaluate(async (uid) => {
          try {
            const r = await fetch('/v1/trigger/trace/public/cycleData', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: 90 }),
            })
            if (r.status === 403) return { blocked: true }
            const text = await r.text()
            if (text.includes('challenge') || text.includes('cloudflare')) return { blocked: true }
            return JSON.parse(text)
          } catch(e) { return { error: e.message } }
        }, row.source_trader_id),
        new Promise(r => setTimeout(() => r({ timeout: true }), 10000))
      ])

      if (result?.blocked || result?.timeout) {
        blocked++
        if (blocked >= 5) { console.log(`  ⚠️ Too many blocks`); break }
        await sleep(2000)
        continue
      }

      if (result?.code === '00000' && result.data?.statisticsDTO) {
        blocked = 0
        const s = result.data.statisticsDTO
        const updates = {}
        if (row.win_rate === null && s.winningRate) updates.win_rate = parseFloat(s.winningRate)
        if (row.max_drawdown === null && s.maxRetracement) updates.max_drawdown = parseFloat(s.maxRetracement)
        if (row.trades_count === null && s.totalTrades) updates.trades_count = parseInt(s.totalTrades)
        if (Object.keys(updates).length) {
          const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
          if (!error) updated++
        }
      }
    } catch {}

    if ((i+1) % 20 === 0 || i === rows.length - 1) {
      console.log(`  [${i+1}/${rows.length}] updated=${updated} blocked=${blocked}`)
    }
    await sleep(800 + Math.random() * 500)
  }
  return updated
}

async function enrichWeex(page, rows) {
  console.log(`\n📡 Weex: enriching ${rows.length} traders...`)
  
  // Intercept list API responses
  const wrData = new Map()
  page.on('response', async (r) => {
    if (!r.url().includes('traderListView') && !r.url().includes('topTraderListView')) return
    try {
      const json = await r.json()
      if (json.code !== 'SUCCESS') return
      for (const item of (json.data?.rows || [])) {
        const id = String(item.traderUserId || '')
        if (!id) continue
        for (const col of (item.itemVoList || [])) {
          const desc = (col.showColumnDesc || '').toLowerCase()
          if (desc.includes('win rate')) {
            const val = parseFloat(col.showColumnValue)
            if (!isNaN(val) && val >= 0 && val <= 100) wrData.set(id, { wr: val })
          }
        }
      }
    } catch {}
  })
  
  // Scroll to trigger API
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 500))
    await sleep(2000)
  }
  console.log(`  From list interception: ${wrData.size} traders`)

  // Visit detail pages for remaining
  const remaining = rows.filter(r => !wrData.has(r.source_trader_id))
  console.log(`  Scraping ${remaining.length} detail pages...`)
  
  for (let i = 0; i < remaining.length; i++) {
    const row = remaining[i]
    try {
      await page.goto(`https://www.weex.com/copy-trading/trader/${row.source_trader_id}`, {
        timeout: 20000, waitUntil: 'domcontentloaded'
      })
      await sleep(5000)
      
      const result = await page.evaluate(() => {
        const text = document.body?.innerText || ''
        const tradesMatch = text.match(/Trades\s*\n\s*(\d[\d,]*)/i)
        const winsMatch = text.match(/Wins\s*\n\s*(\d[\d,]*)/i)
        if (tradesMatch && winsMatch) {
          const trades = parseInt(tradesMatch[1].replace(/,/g, ''))
          const wins = parseInt(winsMatch[1].replace(/,/g, ''))
          if (trades > 0) return { wr: Math.round(wins / trades * 10000) / 100, tc: trades }
        }
        // Try other patterns
        const wrMatch = text.match(/Win Rate\s*\n?\s*([\d.]+)\s*%/i)
        const tcMatch = text.match(/(?:Total )?Trades\s*\n?\s*(\d[\d,]*)/i)
        return {
          wr: wrMatch ? parseFloat(wrMatch[1]) : null,
          tc: tcMatch ? parseInt(tcMatch[1].replace(/,/g, '')) : null,
        }
      })
      
      if (result && (result.wr != null || result.tc != null)) {
        wrData.set(row.source_trader_id, result)
      }
    } catch {}
    if ((i+1) % 10 === 0) console.log(`    [${i+1}/${remaining.length}]`)
  }

  // Update DB
  let updated = 0
  for (const row of rows) {
    const d = wrData.get(row.source_trader_id)
    if (!d) continue
    const updates = {}
    if (row.win_rate === null && d.wr != null) updates.win_rate = d.wr
    if (row.trades_count === null && d.tc != null) updates.trades_count = d.tc
    if (!Object.keys(updates).length) continue
    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) updated++
  }
  return updated
}

async function main() {
  const config = CONFIGS[platform]
  
  // Get rows needing enrichment
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
    .eq('source', platform)
    .eq('season_id', '90D')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

  if (error) { console.error(error); return }
  console.log(`${platform} 90D: ${rows.length} rows need enrichment`)
  if (!rows.length) return

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  
  const page = await ctx.newPage()
  console.log(`  Navigating to ${config.startUrl}...`)
  await page.goto(config.startUrl, { timeout: 45000, waitUntil: 'domcontentloaded' })
  await sleep(config.waitMs)

  let updated = 0
  if (platform === 'bingx') updated = await enrichBingX(page, rows)
  else if (platform === 'bitget_futures') updated = await enrichBitgetFutures(page, rows)
  else if (platform === 'weex') updated = await enrichWeex(page, rows)

  await browser.close()
  console.log(`\n✅ ${platform} done: updated=${updated}/${rows.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })

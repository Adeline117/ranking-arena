#!/usr/bin/env node
/**
 * Weex - Enrich leaderboard_ranks via browser-based API calls
 * Uses puppeteer-extra stealth to bypass Cloudflare
 */
import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pg from 'pg'

puppeteer.use(StealthPlugin())

const DB_URL = process.env.DATABASE_URL
const RANGE_MAP = { '7D': 7, '30D': 30, '90D': 90 }

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
  
  console.log('  🌐 Loading Weex...')
  await Promise.race([
    page.goto('https://www.weex.com/zh-CN/copy-trading', { waitUntil: 'domcontentloaded', timeout: 30000 }),
    new Promise(r => setTimeout(r, 30000))
  ]).catch(() => {})
  await new Promise(r => setTimeout(r, 5000))
  
  // Accept cookies/popups
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach(btn => {
      if (/OK|Got|Accept|同意|确定/i.test(btn.textContent)) try { btn.click() } catch {}
    })
  }).catch(() => {})
  await new Promise(r => setTimeout(r, 1000))
  
  return { browser, page }
}

async function main() {
  const seasonArg = process.argv[2] || 'ALL'
  const periods = seasonArg === 'ALL' ? ['7D', '30D', '90D'] : [seasonArg]
  
  const db = new pg.Client(DB_URL)
  await db.connect()

  let { browser, page } = await launchBrowser()
  console.log('  ✅ Browser ready')

  // First test if API works from browser context
  const testResult = await page.evaluate(async () => {
    try {
      const r = await fetch('/gateway/v2/futures-copy-trade/public/traderListView', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNum: 1, pageSize: 5, sortField: 'ROI', sortDirection: 'DESC', dataRange: 90 }),
      })
      const text = await r.text()
      return { status: r.status, body: text.substring(0, 500) }
    } catch(e) { return { error: e.message } }
  }).catch(e => ({ error: e.message }))
  console.log('  Test:', testResult.status, testResult.body?.substring(0, 200) || testResult.error)

  for (const period of periods) {
    const dataRange = RANGE_MAP[period]
    
    const { rows: missing } = await db.query(`
      SELECT source_trader_id, win_rate, max_drawdown, trades_count
      FROM leaderboard_ranks 
      WHERE source='weex' AND season_id=$1
      AND (win_rate IS NULL OR max_drawdown IS NULL OR trades_count IS NULL)
      ORDER BY rank ASC
    `, [period])

    console.log(`\n  📊 Weex ${period}: ${missing.length} traders need enrichment`)
    if (!missing.length) continue

    // Try list API first from browser
    const enrichMap = new Map()
    console.log(`  📋 List API...`)
    for (let pageNum = 1; pageNum <= 10; pageNum++) {
      const result = await page.evaluate(async (pn, dr) => {
        try {
          const r = await fetch('/gateway/v2/futures-copy-trade/public/traderListView', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pageNum: pn, pageSize: 50, sortField: 'ROI', sortDirection: 'DESC', dataRange: dr }),
          })
          if (!r.ok) return { status: r.status }
          return await r.json()
        } catch(e) { return { error: e.message } }
      }, pageNum, dataRange).catch(() => null)

      if (!result || result.code !== 'SUCCESS') {
        console.log(`    page ${pageNum}: ${JSON.stringify(result)?.substring(0, 150)}`)
        break
      }
      const items = result.data?.rows || []
      if (!items.length) break
      for (const item of items) {
        const id = String(item.traderUserId || '')
        if (!id) continue
        let wr = null, tc = null, mdd = null
        for (const col of (item.itemVoList || [])) {
          const desc = (col.showColumnDesc || '').toLowerCase()
          if (desc.includes('win') || desc.includes('胜')) wr = parseFloat(col.showColumnValue)
          if (desc.includes('trade') || desc.includes('order') || desc.includes('交易') || desc.includes('笔')) tc = parseInt(col.showColumnValue)
          if (desc.includes('draw') || desc.includes('mdd') || desc.includes('回撤')) mdd = parseFloat(col.showColumnValue)
        }
        if (wr === null && item.winRate != null) wr = parseFloat(item.winRate)
        if (tc === null && item.totalOrderNum != null) tc = parseInt(item.totalOrderNum)
        if (mdd === null && item.maxDrawdown != null) mdd = parseFloat(item.maxDrawdown)
        enrichMap.set(id, { wr, tc, mdd })
      }
      await new Promise(r => setTimeout(r, 500))
    }
    console.log(`    List: ${enrichMap.size} traders`)

    // Individual detail for remaining
    const remaining = missing.filter(r => !enrichMap.has(r.source_trader_id))
    console.log(`    Detail for ${remaining.length} remaining...`)
    let consecutiveErrors = 0
    for (let i = 0; i < remaining.length; i++) {
      if (consecutiveErrors >= 5) {
        console.log('    🔄 Restarting browser...')
        await browser.close().catch(() => {})
        await new Promise(r => setTimeout(r, 3000))
        ;({ browser, page } = await launchBrowser())
        consecutiveErrors = 0
      }

      const t = remaining[i]
      try {
        const result = await Promise.race([
          page.evaluate(async (uid, dr) => {
            try {
              const r = await fetch('/gateway/v2/futures-copy-trade/public/traderDetailView?traderUserId=' + uid + '&dataRange=' + dr)
              if (!r.ok) return { status: r.status }
              return await r.json()
            } catch(e) { return { error: e.message } }
          }, t.source_trader_id, dataRange),
          new Promise(r => setTimeout(() => r({ timeout: true }), 15000))
        ])

        if (result?.code === 'SUCCESS' && result.data) {
          consecutiveErrors = 0
          const d = result.data
          let wr = d.winRate != null ? parseFloat(d.winRate) : null
          let tc = d.totalOrderNum != null ? parseInt(d.totalOrderNum) : null
          let mdd = d.maxDrawdown != null ? parseFloat(d.maxDrawdown) : null
          enrichMap.set(t.source_trader_id, { wr, tc, mdd })
        } else {
          consecutiveErrors++
        }
      } catch { consecutiveErrors++ }

      if ((i + 1) % 20 === 0) console.log(`      [${i + 1}/${remaining.length}]`)
      await new Promise(r => setTimeout(r, 800 + Math.random() * 500))
    }

    // Update DB
    let updated = 0
    for (const t of missing) {
      const d = enrichMap.get(t.source_trader_id)
      if (!d) continue
      const sets = [], vals = [t.source_trader_id, period]
      let idx = 3
      if (t.win_rate === null && d.wr != null && !isNaN(d.wr)) { sets.push(`win_rate=$${idx++}`); vals.push(d.wr) }
      if (t.max_drawdown === null && d.mdd != null && !isNaN(d.mdd)) { sets.push(`max_drawdown=$${idx++}`); vals.push(Math.abs(d.mdd)) }
      if (t.trades_count === null && d.tc != null && !isNaN(d.tc)) { sets.push(`trades_count=$${idx++}`); vals.push(d.tc) }
      if (sets.length) {
        await db.query(`UPDATE leaderboard_ranks SET ${sets.join(',')} WHERE source='weex' AND source_trader_id=$1 AND season_id=$2`, vals)
        updated++
      }
    }
    console.log(`  ✅ Weex ${period}: ${updated} updated`)
  }

  await browser.close().catch(() => {})
  
  // Final verification
  const { rows: verify } = await db.query(`
    SELECT season_id, count(*)::int as total,
      count(win_rate)::int as wr, count(max_drawdown)::int as mdd, count(trades_count)::int as tc
    FROM leaderboard_ranks WHERE source='weex'
    GROUP BY season_id ORDER BY season_id
  `)
  console.log('\n  Verification:')
  for (const v of verify) {
    console.log(`    ${v.season_id} total=${v.total} wr=${v.wr}(${Math.round(v.wr/v.total*100)}%) mdd=${v.mdd}(${Math.round(v.mdd/v.total*100)}%) tc=${v.tc}(${Math.round(v.tc/v.total*100)}%)`)
  }

  await db.end()
}

main().catch(e => { console.error(e); process.exit(1) })

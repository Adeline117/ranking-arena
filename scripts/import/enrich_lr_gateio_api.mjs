#!/usr/bin/env node
/**
 * Enrich Gate.io leaderboard_ranks with win_rate and max_drawdown
 * Uses Playwright to access Gate.io internal APIs from browser context.
 * 
 * - Futures traders: fetched from /apiw/v2/copy/leader/list
 * - CTA traders: fetched from /apiw/v2/copy/leader/query_cta_trader (+ detail if available)
 */
import { chromium } from 'playwright'
import pg from 'pg'

const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const pool = new pg.Pool({ connectionString: DB_URL })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('=== Gate.io LR Enrichment via API ===')
  console.log(new Date().toISOString())

  // 1. Get all gateio LR rows with null win_rate
  const { rows: missing } = await pool.query(
    `SELECT id, source_trader_id, season_id, win_rate, max_drawdown 
     FROM leaderboard_ranks WHERE source='gateio' AND win_rate IS NULL`
  )
  console.log(`Found ${missing.length} rows with null win_rate`)
  if (missing.length === 0) { await pool.end(); return }

  // Group by trader ID
  const traderIds = [...new Set(missing.map(r => r.source_trader_id))]
  const ctaIds = traderIds.filter(id => id.startsWith('cta_'))
  const futuresIds = traderIds.filter(id => !id.startsWith('cta_'))
  console.log(`CTA traders: ${ctaIds.length}, Futures traders: ${futuresIds.length}`)

  // 2. Launch browser
  let browser
  try {
    browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:7890' }, args: ['--no-sandbox'] })
  } catch {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  })
  const page = await context.newPage()

  console.log('Navigating to gate.io...')
  await page.goto('https://www.gate.io/copytrading', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(e => console.log('Nav warning:', e.message))
  await sleep(8000)
  console.log('Page title:', await page.title().catch(() => '?'))

  // 3. Fetch ALL futures traders from list API (they have win_rate)
  console.log('\n--- Fetching futures leader list ---')
  page.setDefaultTimeout(120000)
  const futuresData = {}
  for (const cycle of ['week', 'month', 'quarter']) {
    for (const status of ['running']) {
      for (const orderBy of ['profit_rate', 'win_rate', 'max_drawdown']) {
        const batch = await page.evaluate(async ({ cycle, orderBy, status }) => {
          const traders = {}
          for (let pg = 1; pg <= 15; pg++) {
            try {
              let url = `/apiw/v2/copy/leader/list?page=${pg}&page_size=100&order_by=${orderBy}&sort_by=desc&cycle=${cycle}`
              if (status) url += `&status=${status}`
              const r = await fetch(url)
              const j = await r.json()
              const list = j?.data?.list || []
              if (list.length === 0) break
              for (const t of list) {
                const id = String(t.leader_id)
                traders[id] = {
                  winRate: t.win_rate ? parseFloat(t.win_rate) * 100 : null,
                  maxDrawdown: t.max_drawdown ? parseFloat(t.max_drawdown) * 100 : null,
                }
              }
            } catch { break }
          }
          return traders
        }, { cycle, orderBy, status })
        const newCount = Object.keys(batch).filter(k => !futuresData[k]).length
        if (newCount > 0) {
          Object.assign(futuresData, batch)
          console.log(`  ${cycle}/${status||'default'}/${orderBy}: +${newCount} new (total: ${Object.keys(futuresData).length})`)
        }
        await sleep(500)
      }
    }
  }
  console.log(`Futures API returned ${Object.keys(futuresData).length} unique traders`)

  // 4. Test CTA detail endpoints
  console.log('\n--- Testing CTA detail endpoints ---')
  const ctaTestResult = await page.evaluate(async () => {
    const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=3&sort_field=NINETY_PROFIT_RATE_SORT')
    const j = await r.json()
    const list = j?.data?.list || []
    if (list.length === 0) return { error: 'no CTA traders found' }
    const sample = list[0]
    const nick = sample.nickname || ''
    const uid = sample.user_id || sample.trader_id || sample.id || ''
    
    const endpoints = [
      `/apiw/v2/copy/leader/cta_detail?nickname=${encodeURIComponent(nick)}`,
      `/apiw/v2/copy/leader/cta_detail?user_id=${uid}`,
      `/apiw/v2/copy/cta/detail?nickname=${encodeURIComponent(nick)}`,
      `/apiw/v2/copy/leader/query_cta_trader_detail?nickname=${encodeURIComponent(nick)}`,
    ]
    
    const tests = []
    for (const ep of endpoints) {
      try {
        const r2 = await fetch(ep)
        const j2 = await r2.json()
        tests.push({ ep, status: r2.status, raw: JSON.stringify(j2).slice(0, 300) })
      } catch (e) { tests.push({ ep, error: e.message }) }
    }
    return { sampleFields: Object.keys(sample), sample, tests }
  })
  console.log('CTA sample fields:', JSON.stringify(ctaTestResult.sampleFields))
  if (ctaTestResult.sample) {
    const s = ctaTestResult.sample
    console.log('CTA sample:', JSON.stringify({ nickname: s.nickname, win_rate: s.win_rate, max_drawdown: s.max_drawdown, total_profit_rate: s.total_profit_rate }, null, 2))
    // Log ALL fields to find hidden WR/MDD
    console.log('ALL CTA fields:', JSON.stringify(s, null, 2))
  }
  for (const t of (ctaTestResult.tests || [])) {
    console.log(`  ${t.ep}: ${t.status || t.error}`)
    if (t.raw) console.log(`    ${t.raw.slice(0, 200)}`)
  }

  // 5. Fetch ALL CTA traders - compute win_rate from daily profit history
  // CTA API doesn't provide win_rate/max_drawdown directly, so we compute:
  // - win_rate = % of days with positive profit
  // - max_drawdown = max peak-to-trough decline in cumulative profit_rate
  console.log('\n--- Fetching all CTA traders (with daily history) ---')
  const ctaData = {}
  for (const sortField of ['NINETY_PROFIT_RATE_SORT', 'THIRTY_PROFIT_RATE_SORT', 'SEVEN_PROFIT_RATE_SORT', 'COPY_USER_COUNT_SORT']) {
    const batch = await page.evaluate(async (sortField) => {
      const traders = {}
      for (let pg = 1; pg <= 30; pg++) {
        try {
          const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=100&sort_field=${sortField}`)
          const j = await r.json()
          const list = j?.data?.list || []
          if (list.length === 0) break
          for (const t of list) {
            const nick = t.nickname || t.nick || ''
            const id = 'cta_' + nick.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
            if (!nick || traders[id]) continue
            
            // Compute win_rate from strategy_profit_list
            const profitList = t.strategy_profit_list || []
            let winRate = null, maxDrawdown = null
            
            if (profitList.length > 0) {
              // Win rate = % of days with positive daily change
              // We need daily changes, not cumulative
              // Sort by date ascending
              const sorted = [...profitList].sort((a, b) => a.trade_date - b.trade_date)
              let wins = 0, total = 0
              for (let i = 1; i < sorted.length; i++) {
                const prevPnl = parseFloat(sorted[i-1].profit || 0)
                const curPnl = parseFloat(sorted[i].profit || 0)
                const dailyChange = curPnl - prevPnl
                total++
                if (dailyChange > 0) wins++
              }
              if (total > 0) winRate = (wins / total) * 100
              
              // Max drawdown from profit_rate series
              const rates = sorted.map(d => parseFloat(d.profit_rate || 0))
              let peak = rates[0], mdd = 0
              for (const r of rates) {
                if (r > peak) peak = r
                const dd = peak - r
                if (dd > mdd) mdd = dd
              }
              maxDrawdown = mdd  // already in percentage points
            }
            
            traders[id] = { winRate, maxDrawdown }
          }
        } catch { break }
      }
      return traders
    }, sortField)
    const newCount = Object.keys(batch).filter(k => !ctaData[k]).length
    Object.assign(ctaData, batch)
    console.log(`  ${sortField}: +${newCount} new (total: ${Object.keys(ctaData).length})`)
    await sleep(1000)
  }
  
  const ctaCount = Object.keys(ctaData).length
  console.log(`CTA list returned ${ctaCount} unique traders`)
  // Check if any have win_rate
  const ctaWithWR = Object.values(ctaData).filter(t => t.winRate != null).length
  console.log(`CTA with win_rate: ${ctaWithWR}/${ctaCount}`)
  
  // Show sample CTA numeric fields
  const sampleCta = Object.values(ctaData)[0]
  if (sampleCta) {
    console.log('Sample CTA numeric fields:', JSON.stringify(sampleCta._all_numeric, null, 2))
  }

  // 5b. Try individual futures trader detail API for remaining futures traders
  const missingFuturesIds = [...new Set(missing.filter(r => !r.source_trader_id.startsWith('cta_') && !futuresData[r.source_trader_id]).map(r => r.source_trader_id))]
  if (missingFuturesIds.length > 0) {
    console.log(`\n--- Fetching ${missingFuturesIds.length} individual futures traders ---`)
    for (const lid of missingFuturesIds) {
      const detail = await page.evaluate(async (leaderId) => {
        try {
          const r = await fetch(`/apiw/v2/copy/leader/detail?leader_id=${leaderId}`)
          const j = await r.json()
          const d = j?.data
          if (!d) return null
          return {
            winRate: d.win_rate ? parseFloat(d.win_rate) * 100 : null,
            maxDrawdown: d.max_drawdown ? parseFloat(d.max_drawdown) * 100 : null,
          }
        } catch { return null }
      }, lid)
      if (detail && (detail.winRate != null || detail.maxDrawdown != null)) {
        futuresData[lid] = detail
        console.log(`  ${lid}: WR=${detail.winRate} MDD=${detail.maxDrawdown}`)
      } else {
        console.log(`  ${lid}: no detail data`)
      }
      await sleep(1000)
    }
  }

  // 5c. Try more CTA sort fields / pages
  const missingCtaIds = new Set(missing.filter(r => r.source_trader_id.startsWith('cta_') && !ctaData[r.source_trader_id]).map(r => r.source_trader_id))
  console.log(`\nCTA still missing: ${missingCtaIds.size} unique traders`)

  // 6. Update DB
  console.log('\n--- Updating database ---')
  let updated = 0, skipped = 0

  for (const row of missing) {
    const tid = row.source_trader_id
    let wr = null, mdd = null

    if (tid.startsWith('cta_')) {
      const cta = ctaData[tid]
      if (cta) {
        wr = cta.winRate
        mdd = cta.maxDrawdown
      }
    } else {
      const fut = futuresData[tid]
      if (fut) {
        wr = fut.winRate
        mdd = fut.maxDrawdown
      }
    }

    if (wr == null && mdd == null) {
      skipped++
      continue
    }

    const setClauses = []
    const vals = []
    let idx = 1
    if (wr != null) { setClauses.push(`win_rate = $${idx++}`); vals.push(wr) }
    if (mdd != null) { setClauses.push(`max_drawdown = $${idx++}`); vals.push(Math.abs(mdd)) }
    vals.push(row.id)

    await pool.query(
      `UPDATE leaderboard_ranks SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      vals
    )
    updated++
    if (updated % 100 === 0) console.log(`  Updated ${updated}...`)
  }

  console.log(`\n✅ Done: updated=${updated}, skipped=${skipped}, total=${missing.length}`)

  // 7. Verify
  const { rows: [{ count: remaining }] } = await pool.query(
    `SELECT COUNT(*) as count FROM leaderboard_ranks WHERE source='gateio' AND win_rate IS NULL`
  )
  console.log(`Remaining null win_rate: ${remaining}`)

  await browser.close()
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })

#!/usr/bin/env node
/**
 * Enrich PNL + Equity Curves for bybit, bitget_futures, and other sources
 * 
 * 1. Bybit: Direct API (leader-income + yield-trend)
 * 2. Bitget: Puppeteer + stealth (cycleData API)
 * 3. Updates trader_snapshots.pnl from fetched data
 * 4. Writes equity curves to trader_equity_curve
 * 
 * Usage:
 *   node scripts/enrich-pnl-equity.mjs --source=bybit [--limit=100]
 *   node scripts/enrich-pnl-equity.mjs --source=bitget_futures [--limit=50]
 *   node scripts/enrich-pnl-equity.mjs --source=all
 */
import { readFileSync } from 'fs'

// Load .env.local
try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const SOURCE = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'all'
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')
const DRY_RUN = args.includes('--dry-run')

// ═══════════════════════════════════════════════════════════
// DB Helpers
// ═══════════════════════════════════════════════════════════

async function upsertEquityCurve(source, traderId, period, points) {
  if (!points?.length || DRY_RUN) return points?.length || 0
  const now = new Date().toISOString()
  const rows = points.map(p => ({
    source, source_trader_id: traderId, period,
    data_date: p.date,
    roi_pct: p.roi ?? null,
    pnl_usd: p.pnl ?? null,
    captured_at: now,
  }))
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await sb.from('trader_equity_curve')
      .upsert(rows.slice(i, i + 100), { onConflict: 'source,source_trader_id,period,data_date' })
    if (error) { console.log(`  ⚠ equity upsert: ${error.message}`); return 0 }
  }
  return rows.length
}

async function upsertStatsDetail(source, traderId, period, stats) {
  if (!stats || DRY_RUN) return 0
  const now = new Date().toISOString()
  const row = { source, source_trader_id: traderId, period, captured_at: now, ...stats }
  await sb.from('trader_stats_detail')
    .delete().eq('source', source).eq('source_trader_id', traderId).eq('period', period)
  const { error } = await sb.from('trader_stats_detail').insert(row)
  if (error) { console.log(`  ⚠ stats upsert: ${error.message}`); return 0 }
  return 1
}

async function updateSnapshotPnl(source, traderId, pnl) {
  if (pnl == null || DRY_RUN) return 0
  const { rowCount } = await pool.query(
    `UPDATE trader_snapshots SET pnl = $1 WHERE source = $2 AND source_trader_id = $3 AND pnl IS NULL`,
    [pnl, source, traderId]
  )
  return rowCount || 0
}

// ═══════════════════════════════════════════════════════════
// BYBIT - Direct API
// ═══════════════════════════════════════════════════════════

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (res.status === 403 || !res.ok) return null
      const text = await res.text()
      if (text.startsWith('<')) return null
      return JSON.parse(text)
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

const BYBIT_INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'
const BYBIT_YIELD_URL = 'https://api2.bybit.com/fapi/beehive/public/v2/leader/yield-trend'
const BYBIT_PERIODS = {
  '7D':  'DAY_CYCLE_TYPE_SEVEN_DAY',
  '30D': 'DAY_CYCLE_TYPE_THIRTY_DAY',
  '90D': 'DAY_CYCLE_TYPE_NINETY_DAY',
}

async function enrichBybit() {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`📊 Bybit Detail Enrichment (direct API)`)
  console.log(`${'═'.repeat(60)}`)

  // Get bybit traders with null PNL and valid leaderMarks
  const { rows } = await pool.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'bybit' AND pnl IS NULL 
      AND (source_trader_id LIKE '%==%' OR source_trader_id ~ '^\\d{9,}$')
    LIMIT $1
  `, [LIMIT])
  
  console.log(`Found ${rows.length} bybit traders with null PNL`)
  if (!rows.length) return

  let statsN = 0, equityN = 0, pnlN = 0, errors = 0

  for (let i = 0; i < rows.length; i++) {
    const tid = rows[i].source_trader_id
    const enc = encodeURIComponent(tid)
    
    try {
      // 1. Fetch leader-income (stats + PNL)
      const incomeJson = await fetchJSON(`${BYBIT_INCOME_URL}?leaderMark=${enc}`)
      if (incomeJson?.retCode === 0 && incomeJson.result) {
        const r = incomeJson.result
        
        // Extract PNL (cumulative yield in E8)
        const cumPnlE8 = parseInt(r.ninetyDayYieldE8 || r.thirtyDayYieldE8 || r.sevenDayYieldE8 || '0')
        if (cumPnlE8 !== 0) {
          const pnlUsd = cumPnlE8 / 1e8
          const updated = await updateSnapshotPnl('bybit', tid, pnlUsd)
          if (updated > 0) pnlN++
        }
        
        // Upsert stats for each period
        const prefixMap = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }
        for (const [period, pfx] of Object.entries(prefixMap)) {
          const winCount = parseInt(r[pfx + 'WinCount'] || '0')
          const lossCount = parseInt(r[pfx + 'LossCount'] || '0')
          const totalTrades = winCount + lossCount
          if (totalTrades === 0) continue
          
          await upsertStatsDetail('bybit', tid, period, {
            roi: parseInt(r[pfx + 'YieldRateE4'] || '0') / 100,
            total_trades: totalTrades,
            profitable_trades_pct: (winCount / totalTrades) * 100,
            sharpe_ratio: parseInt(r[pfx + 'SharpeRatioE4'] || '0') / 10000 || null,
            max_drawdown: parseInt(r[pfx + 'DrawDownE4'] || '0') / 100 || null,
            copiers_count: parseInt(r.currentFollowerCount || '0'),
            aum: parseInt(r.aumE8 || '0') / 1e8 || null,
            winning_positions: winCount,
            total_positions: totalTrades,
          })
          statsN++
        }
      }
      await sleep(600)
      
      // 2. Fetch yield-trend (equity curve) for each period
      for (const [period, dayCycleType] of Object.entries(BYBIT_PERIODS)) {
        const url = `${BYBIT_YIELD_URL}?dayCycleType=${dayCycleType}&period=PERIOD_DAY&leaderMark=${enc}`
        const json = await fetchJSON(url)
        const trend = json?.result?.yieldTrend
        if (trend?.length > 0) {
          const points = trend.map(p => ({
            date: new Date(parseInt(p.statisticDate)).toISOString().split('T')[0],
            roi: parseInt(p.cumResetRoiE4 || p.yieldRateE4 || '0') / 100,
            pnl: parseInt(p.cumResetPnlE8 || p.yieldE8 || '0') / 1e8,
          }))
          const n = await upsertEquityCurve('bybit', tid, period, points)
          if (n > 0) equityN++
        }
        await sleep(400)
      }
    } catch (e) {
      errors++
      if (errors < 5) console.log(`  ⚠ ${tid}: ${e.message}`)
    }
    
    if ((i + 1) % 20 === 0 || i === rows.length - 1) {
      console.log(`  [${i + 1}/${rows.length}] pnl=${pnlN} stats=${statsN} equity=${equityN} err=${errors}`)
    }
  }

  console.log(`\n✅ Bybit: PNL updated=${pnlN}, stats=${statsN}, equity=${equityN}, errors=${errors}`)
}

// ═══════════════════════════════════════════════════════════
// BITGET FUTURES - Puppeteer + Stealth
// ═══════════════════════════════════════════════════════════

async function enrichBitgetFutures() {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`📊 Bitget Futures Detail Enrichment (puppeteer)`)
  console.log(`${'═'.repeat(60)}`)

  // Get bitget traders with null PNL
  const { rows } = await pool.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'bitget_futures' AND pnl IS NULL
    LIMIT $1
  `, [LIMIT])
  
  console.log(`Found ${rows.length} bitget_futures traders with null PNL`)
  if (!rows.length) return

  const puppeteer = (await import('puppeteer-extra')).default
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  let pnlN = 0, statsN = 0, equityN = 0, errors = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent(UA)

    // Get CF clearance
    console.log('🌐 Getting Cloudflare clearance...')
    await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    await sleep(5000)
    
    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('OK') || text.includes('Got') || text.includes('Accept')) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(1000)
    console.log('✅ Browser ready')

    const CYCLE_MAP = { '7D': 7, '30D': 30, '90D': 90 }

    for (let i = 0; i < rows.length; i++) {
      const tid = rows[i].source_trader_id
      
      try {
        // First resolve handle to numeric UID by visiting profile
        let uid = null
        if (/^\d+$/.test(tid)) {
          uid = tid
        } else {
          const profileUrl = `https://www.bitget.com/copy-trading/trader/${encodeURIComponent(tid)}`
          
          const reqHandler = (req) => {
            try {
              const pd = req.postData()
              if (pd?.includes('triggerUserId')) {
                const parsed = JSON.parse(pd)
                if (parsed.triggerUserId) uid = parsed.triggerUserId
              }
            } catch {}
          }
          page.on('request', reqHandler)
          
          try {
            await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
            await sleep(3000)
            
            if (!uid) {
              uid = await page.evaluate(() => {
                try {
                  const nd = window.__NEXT_DATA__
                  if (nd?.props?.pageProps?.traderInfo?.uid) return nd.props.pageProps.traderInfo.uid
                  if (nd?.props?.pageProps?.traderInfo?.triggerUserId) return nd.props.pageProps.traderInfo.triggerUserId
                } catch {}
                const scripts = document.querySelectorAll('script')
                for (const s of scripts) {
                  const m = s.textContent?.match(/"triggerUserId"\s*:\s*"(\d+)"/)
                  if (m) return m[1]
                }
                return null
              }).catch(() => null)
            }
          } finally {
            page.off('request', reqHandler)
          }

          if (!uid) {
            errors++
            continue
          }
        }

        // Fetch cycleData for each period
        for (const [period, cycleTime] of Object.entries(CYCLE_MAP)) {
          const result = await page.evaluate(async (uid, ct) => {
            try {
              const r = await fetch('/v1/trigger/trace/public/cycleData', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: ct }),
              })
              return await r.json()
            } catch (e) { return { error: e.message } }
          }, uid, cycleTime)

          if (result?.code === '00000' && result.data) {
            const d = result.data
            
            // Extract PNL from statisticsDTO
            if (d.statisticsDTO?.totalProfit && period === '90D') {
              const pnl = parseFloat(d.statisticsDTO.totalProfit)
              if (pnl !== 0 && !isNaN(pnl)) {
                const updated = await updateSnapshotPnl('bitget_futures', tid, pnl)
                if (updated > 0) pnlN++
              }
            }
            
            // Equity curve
            if (d.roiRows?.rows?.length > 0) {
              const points = d.roiRows.rows.map(r => ({
                date: new Date(r.dataTime).toISOString().split('T')[0],
                roi: parseFloat(r.amount || '0'),
                pnl: null,
              }))
              const n = await upsertEquityCurve('bitget_futures', tid, period, points)
              if (n > 0) equityN++
            }
            
            // Stats
            if (d.statisticsDTO) {
              const s = d.statisticsDTO
              await upsertStatsDetail('bitget_futures', tid, period, {
                roi: parseFloat(s.profitRate || '0') || null,
                total_trades: parseInt(s.totalTrades || '0') || null,
                profitable_trades_pct: parseFloat(s.winningRate || '0') || null,
                max_drawdown: parseFloat(s.maxRetracement || '0') || null,
                copiers_count: parseInt(s.totalFollowers || '0') || null,
                aum: parseFloat(s.aum || '0') || null,
                winning_positions: parseInt(s.profitTrades || '0') || null,
                total_positions: parseInt(s.totalTrades || '0') || null,
              })
              statsN++
            }
          }
          
          await sleep(500 + Math.random() * 300)
        }
      } catch (e) {
        errors++
        if (errors < 5) console.log(`  ⚠ ${tid}: ${e.message}`)
      }

      if ((i + 1) % 10 === 0 || i === rows.length - 1) {
        console.log(`  [${i + 1}/${rows.length}] pnl=${pnlN} stats=${statsN} equity=${equityN} err=${errors}`)
      }
      
      await sleep(800 + Math.random() * 400)
    }
  } finally {
    await browser.close()
  }

  console.log(`\n✅ Bitget: PNL updated=${pnlN}, stats=${statsN}, equity=${equityN}, errors=${errors}`)
}

// ═══════════════════════════════════════════════════════════
// BACKFILL PNL FROM EXISTING EQUITY CURVES
// ═══════════════════════════════════════════════════════════

async function backfillPnlFromEquity() {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`📊 Backfill PNL from existing equity_curve data`)
  console.log(`${'═'.repeat(60)}`)

  // For sources that already have equity curve data with pnl_usd, 
  // update trader_snapshots.pnl where it's null
  const result = await pool.query(`
    UPDATE trader_snapshots ts
    SET pnl = sub.total_pnl
    FROM (
      SELECT source, source_trader_id, 
             SUM(pnl_usd) as total_pnl
      FROM trader_equity_curve
      WHERE pnl_usd IS NOT NULL AND pnl_usd != 0
        AND period = '90D'
      GROUP BY source, source_trader_id
    ) sub
    WHERE ts.source = sub.source 
      AND ts.source_trader_id = sub.source_trader_id
      AND ts.pnl IS NULL
  `)
  
  console.log(`✅ Updated ${result.rowCount} snapshot rows with PNL from equity curves`)
  
  // Also try from trader_stats_detail (some have roi but not pnl)
  // We can't fabricate PNL from ROI without knowing initial capital, so skip that
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log(`🚀 PNL + Equity Enrichment`)
  console.log(`   Source: ${SOURCE}, Limit: ${LIMIT}, DryRun: ${DRY_RUN}`)
  
  try {
    if (SOURCE === 'bybit' || SOURCE === 'all') {
      await enrichBybit()
    }
    if (SOURCE === 'bitget_futures' || SOURCE === 'all') {
      await enrichBitgetFutures()
    }
    
    // Always try backfill from existing data
    await backfillPnlFromEquity()
    
    // Print final status
    const { rows } = await pool.query(`
      SELECT source, COUNT(*) FILTER (WHERE pnl IS NULL)::int as pnl_null
      FROM trader_snapshots
      WHERE source IN ('bybit', 'bitget_futures', 'binance_futures')
      GROUP BY source ORDER BY pnl_null DESC
    `)
    console.log('\n📊 Final PNL null counts (priority sources):')
    console.table(rows)
    
  } finally {
    await pool.end()
  }
}

main().catch(console.error)

/**
 * KuCoin Enrichment v2 — WR/MDD from API trade data
 * 
 * Win Rate: from positionHistory (closePnl > 0 = win)
 * Max Drawdown: from pnl/history cumulative ratio curve (peak-to-trough %)
 * 
 * Uses puppeteer to get session cookies, then direct HTTP for speed.
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'
import pg from 'pg'
import fetch from 'node-fetch'

puppeteer.use(StealthPlugin())

const supabase = getSupabaseClient()
const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'

function computeWinRate(positions) {
  if (!positions || positions.length === 0) return null
  const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
  return (wins / positions.length) * 100
}

function computeMDD(pnlHistory) {
  if (!pnlHistory || pnlHistory.length < 2) return null
  const equities = pnlHistory.map(p => 1 + parseFloat(p.ratio))
  let peak = equities[0], maxDD = 0
  for (const eq of equities) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = (peak - eq) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  return Math.min(maxDD * 100, 100)
}

async function getCookies() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto('https://www.kucoin.com/copytrading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
  await sleep(3000)
  const cookies = await page.cookies()
  await browser.close()
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

async function fetchAPI(url, cookieStr) {
  const r = await fetch(url, {
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://www.kucoin.com/copytrading',
    },
    timeout: 10000,
  })
  return r.json()
}

async function fetchTraderData(traderId, cookieStr) {
  const base = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow'
  const [posRes, pnlRes] = await Promise.all([
    fetchAPI(`${base}/positionHistory?leadConfigId=${traderId}&period=90d&lang=en_US`, cookieStr),
    fetchAPI(`${base}/pnl/history?leadConfigId=${traderId}&period=90d&lang=en_US`, cookieStr),
  ])
  
  return {
    winRate: computeWinRate(posRes.success ? posRes.data : null),
    maxDrawdown: computeMDD(pnlRes.success ? pnlRes.data : null),
  }
}

async function main() {
  console.log('=== KuCoin Enrichment v2 ===\n')
  
  const pool = new pg.Pool({ connectionString: DB_URL })
  
  // Reset bad MDD values
  await pool.query("UPDATE trader_snapshots SET max_drawdown = NULL WHERE source = 'kucoin' AND max_drawdown > 100")
  
  // Get traders needing enrichment
  const { rows: traders } = await pool.query(`
    SELECT source_trader_id, season_id, roi, pnl, win_rate, max_drawdown 
    FROM trader_snapshots WHERE source = 'kucoin' AND (win_rate IS NULL OR max_drawdown IS NULL)
  `)
  
  const uniqueIds = [...new Set(traders.map(t => t.source_trader_id))]
  console.log(`${traders.length} snapshots, ${uniqueIds.length} unique traders\n`)
  
  if (uniqueIds.length === 0) { await pool.end(); return }
  
  // Get cookies via puppeteer
  console.log('Getting session cookies...')
  let cookieStr = await getCookies()
  console.log('Cookies obtained\n')
  
  let enriched = 0, failed = 0, noData = 0
  const BATCH = 5
  
  for (let i = 0; i < uniqueIds.length; i += BATCH) {
    const batch = uniqueIds.slice(i, i + BATCH)
    
    const results = await Promise.allSettled(
      batch.map(id => fetchTraderData(id, cookieStr))
    )
    
    for (let j = 0; j < batch.length; j++) {
      const traderId = batch[j]
      const result = results[j]
      
      if (result.status === 'rejected') {
        failed++
        continue
      }
      
      const { winRate, maxDrawdown } = result.value
      
      if (winRate === null && maxDrawdown === null) {
        noData++
        continue
      }
      
      const traderSnaps = traders.filter(t => t.source_trader_id === traderId)
      for (const snap of traderSnaps) {
        const wr = winRate !== null && snap.win_rate === null ? Math.round(winRate * 100) / 100 : snap.win_rate
        const mdd = maxDrawdown !== null && snap.max_drawdown === null ? Math.round(maxDrawdown * 100) / 100 : snap.max_drawdown
        const score = calculateArenaScore(snap.roi, snap.pnl, mdd, wr, snap.season_id)
        
        await pool.query(
          `UPDATE trader_snapshots SET win_rate = $1, max_drawdown = $2, arena_score = $3 
           WHERE source = 'kucoin' AND source_trader_id = $4 AND season_id = $5`,
          [wr, mdd, score.totalScore, traderId, snap.season_id]
        )
        enriched++
      }
    }
    
    if (i % 50 === 0 || i + BATCH >= uniqueIds.length) {
      console.log(`[${Math.min(i + BATCH, uniqueIds.length)}/${uniqueIds.length}] enriched=${enriched} noData=${noData} failed=${failed}`)
    }
    
    // Refresh cookies every 200 requests
    if (i > 0 && i % 200 === 0) {
      console.log('Refreshing cookies...')
      cookieStr = await getCookies()
    }
    
    await sleep(300)
  }
  
  console.log(`\n=== Done ===`)
  console.log(`Enriched: ${enriched}, No data: ${noData}, Failed: ${failed}`)
  
  const { rows } = await pool.query(`
    SELECT season_id, count(*) as total, count(win_rate) as has_wr, count(max_drawdown) as has_mdd,
      round(avg(win_rate)::numeric, 1) as avg_wr, round(avg(max_drawdown)::numeric, 1) as avg_mdd
    FROM trader_snapshots WHERE source = 'kucoin'
    GROUP BY season_id ORDER BY season_id
  `)
  console.log('\nVerification:')
  console.table(rows)
  await pool.end()
}

main().catch(console.error)

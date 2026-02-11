#!/usr/bin/env node
/**
 * KuCoin Detail Enrichment (Browser-based)
 * 
 * Fills: trader_equity_curve, trader_stats_detail
 * 
 * KuCoin has no public per-trader detail API. The leaderboard API returns:
 *   - totalPnlDate: array of cumulative PnL values
 *   - thirtyDayPnl, thirtyDayPnlRatio, totalPnl, totalPnlRatio
 *   - winRatio, maxDrawdown (sometimes)
 * 
 * Strategy: re-fetch leaderboard via puppeteer, extract all available data,
 * and match with existing DB traders.
 * 
 * Usage: node scripts/import/enrich_kucoin_detail.mjs [--limit=500]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SOURCE = 'kucoin'

const limitArg = process.argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 500

// ============================================
// Fetch all KuCoin traders via browser
// ============================================
async function fetchAllLeaderboardTraders() {
  console.log('🌐 Launching browser to fetch KuCoin leaderboard...')
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  
  const allTraders = new Map()
  
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')

    page.on('response', async (res) => {
      if (res.url().includes('leaderboard')) {
        try {
          const ct = res.headers()['content-type'] || ''
          if (ct.includes('json')) {
            const data = JSON.parse(await res.text())
            if (data.data?.items) {
              for (const item of data.data.items) {
                const id = String(item.leadConfigId)
                if (!allTraders.has(id)) allTraders.set(id, item)
              }
              console.log(`  Intercepted: ${data.data.items.length} traders, total: ${allTraders.size}`)
            }
          }
        } catch {}
      }
    })

    await page.goto('https://www.kucoin.com/copytrading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    await sleep(8000)
    
    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button, [class*="close"]').forEach(btn => {
        if ((btn.textContent || '').match(/OK|Got it|×/)) try { btn.click() } catch {}
      })
    }).catch(() => {})
    await sleep(2000)

    // Paginate to get more data
    for (let p = 2; p <= 30 && allTraders.size < LIMIT; p++) {
      const prev = allTraders.size
      
      await page.evaluate(() => window.scrollTo(0, 3500))
      await sleep(500)
      
      const clicked = await page.evaluate((pn) => {
        const items = document.querySelectorAll('.KuxPagination-item a, [class*="pagination"] li a, [class*="pagination"] li')
        for (const item of items) {
          if (item.textContent?.trim() === String(pn)) { item.click(); return true }
        }
        const nextLi = document.querySelector('li.KuxPagination-item[data-item="next"]')
        if (nextLi) {
          const nextBtn = nextLi.querySelector('button:not([disabled])')
          if (nextBtn) { nextBtn.click(); return true }
        }
        return false
      }, p)
      
      if (!clicked) break
      await sleep(3000)
      
      if (allTraders.size === prev) break // No new data
    }
    
    await page.close()
  } finally {
    await browser.close()
  }
  
  return allTraders
}

// ============================================
// DB helpers
// ============================================
async function upsertEquityCurve(traderId, pnlDateArray) {
  if (!Array.isArray(pnlDateArray) || pnlDateArray.length < 2) return 0
  const now = new Date().toISOString()
  const today = new Date()
  let count = 0
  
  // pnlDateArray is cumulative PnL values, most recent last
  const values = pnlDateArray.map(v => parseFloat(v))
  
  for (const period of ['7D', '30D']) {
    const days = period === '7D' ? 7 : 30
    const relevant = values.slice(-days)
    if (relevant.length < 2) continue
    
    const firstVal = relevant[0]
    const rows = relevant.map((v, idx) => {
      const date = new Date(today)
      date.setDate(date.getDate() - (relevant.length - 1 - idx))
      return {
        source: SOURCE, source_trader_id: traderId, period,
        data_date: date.toISOString().split('T')[0],
        roi_pct: firstVal !== 0 ? ((v - firstVal) / Math.abs(firstVal)) * 100 : null,
        pnl_usd: v,
        captured_at: now,
      }
    })
    
    const { error } = await supabase.from('trader_equity_curve')
      .upsert(rows, { onConflict: 'source,source_trader_id,period,data_date' })
    if (!error) count += rows.length
  }
  return count
}

async function upsertStats(traderId, item) {
  const now = new Date().toISOString()
  const thirtyDayPnlRatio = parseFloat(item.thirtyDayPnlRatio || '0')
  const totalPnlRatio = parseFloat(item.totalPnlRatio || '0')
  const thirtyDayPnl = parseFloat(item.thirtyDayPnl || '0')
  const followers = parseInt(item.currentCopyUserCount || '0')
  
  // Compute MDD from totalPnlDate if available
  let mdd = null
  if (item.totalPnlDate?.length >= 2) {
    const values = item.totalPnlDate.map(v => parseFloat(v))
    let peak = values[0], maxDD = 0
    for (const v of values) {
      if (v > peak) peak = v
      if (peak > 0) { const dd = ((peak - v) / peak) * 100; if (dd > maxDD) maxDD = dd }
    }
    mdd = maxDD > 0.01 && maxDD < 100 ? maxDD : null
  }
  
  let count = 0
  for (const period of ['30D', '90D']) {
    const row = {
      source: SOURCE, source_trader_id: traderId, period,
      roi: period === '30D' ? thirtyDayPnlRatio * 100 : totalPnlRatio * 100,
      total_trades: null,
      profitable_trades_pct: null,
      avg_holding_time_hours: null,
      avg_profit: null, avg_loss: null,
      largest_win: null, largest_loss: null,
      sharpe_ratio: null,
      max_drawdown: mdd,
      copiers_count: followers,
      copiers_pnl: parseFloat(item.followerPnl || '0') || null,
      aum: parseFloat(item.leadPrincipal || '0') || null,
      captured_at: now,
    }
    
    await supabase.from('trader_stats_detail')
      .delete().eq('source', SOURCE).eq('source_trader_id', traderId).eq('period', period)
    const { error } = await supabase.from('trader_stats_detail').insert(row)
    if (!error) count++
  }
  return count
}

// ============================================
// Main
// ============================================
async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`KuCoin Detail Enrichment`)
  console.log(`${'='.repeat(60)}`)

  const apiTraders = await fetchAllLeaderboardTraders()
  console.log(`\nFetched ${apiTraders.size} traders from KuCoin API`)
  
  if (apiTraders.size === 0) { console.log('No traders from API'); return }

  // Check which traders exist in DB
  const apiIds = Array.from(apiTraders.keys())
  const { data: dbTraders } = await supabase.from('trader_sources')
    .select('source_trader_id').eq('source', SOURCE).in('source_trader_id', apiIds.slice(0, 500))
  const dbSet = new Set(dbTraders?.map(t => t.source_trader_id) || [])
  
  // Check existing stats
  const { data: existingStats } = await supabase.from('trader_stats_detail')
    .select('source_trader_id').eq('source', SOURCE).in('source_trader_id', apiIds.slice(0, 500))
  const hasStats = new Set(existingStats?.map(e => e.source_trader_id) || [])

  const toProcess = Array.from(apiTraders.entries())
    .filter(([id]) => dbSet.has(id) && !hasStats.has(id))
    .slice(0, LIMIT)

  console.log(`In DB: ${dbSet.size}, has stats: ${hasStats.size}, to process: ${toProcess.length}`)

  let statsN = 0, equityN = 0, errors = 0

  for (let i = 0; i < toProcess.length; i++) {
    const [id, item] = toProcess[i]
    try {
      const sn = await upsertStats(id, item)
      if (sn > 0) statsN++
      
      if (item.totalPnlDate?.length >= 2) {
        const en = await upsertEquityCurve(id, item.totalPnlDate)
        if (en > 0) equityN++
      }
    } catch { errors++ }

    if ((i + 1) % 50 === 0 || i === toProcess.length - 1) {
      console.log(`  [${i + 1}/${toProcess.length}] stats=${statsN} equity=${equityN} err=${errors}`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ KuCoin enrichment done`)
  console.log(`   Stats: ${statsN}, Equity: ${equityN}, Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

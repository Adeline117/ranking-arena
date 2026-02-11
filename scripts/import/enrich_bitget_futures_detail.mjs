#!/usr/bin/env node
/**
 * Bitget Futures Detail Enrichment (Browser-based)
 * 
 * Fills: trader_equity_curve, trader_stats_detail, trader_asset_breakdown
 * 
 * Uses puppeteer to visit bitget.com and call internal APIs:
 *   POST /v1/trigger/trace/public/traderDetailPageV2  → stats
 *   POST /v1/trigger/trace/public/cycleData  → equity curve + stats
 * 
 * Bitget has Cloudflare, so direct fetch doesn't work.
 * We use page.evaluate(fetch) to call APIs with browser cookies.
 * 
 * Usage: node scripts/import/enrich_bitget_futures_detail.mjs [--limit=100] [--offset=0]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { sb, sleep } from './lib/index.mjs'

puppeteer.use(StealthPlugin())

const SOURCE = 'bitget_futures'

const args = process.argv.slice(2)
const limitArg = args.find(a => a.startsWith('--limit='))
const offsetArg = args.find(a => a.startsWith('--offset='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 100
const OFFSET = offsetArg ? parseInt(offsetArg.split('=')[1]) : 0

const CYCLE_MAP = { '7D': 7, '30D': 30, '90D': 90 }

// ============================================
// DB helpers
// ============================================
async function upsertEquityCurve(traderId, period, rows) {
  if (!rows?.length) return 0
  const now = new Date().toISOString()
  const data = rows.map(r => ({
    source: SOURCE, source_trader_id: traderId, period,
    data_date: new Date(r.dataTime).toISOString().split('T')[0],
    roi_pct: parseFloat(r.amount || '0'),
    pnl_usd: null,
    captured_at: now,
  }))
  const { error } = await sb.from('trader_equity_curve')
    .upsert(data, { onConflict: 'source,source_trader_id,period,data_date' })
  if (error) { console.log(`  ⚠ equity: ${error.message}`); return 0 }
  return data.length
}

async function upsertStats(traderId, period, stats) {
  if (!stats) return 0
  const now = new Date().toISOString()
  const row = {
    source: SOURCE, source_trader_id: traderId, period,
    roi: parseFloat(stats.profitRate || '0') || null,
    total_trades: parseInt(stats.totalTrades || '0') || null,
    profitable_trades_pct: parseFloat(stats.winningRate || '0') || null,
    avg_holding_time_hours: stats.averageHoldingTime ? stats.averageHoldingTime / 3600000 : null,
    avg_profit: parseFloat(stats.avgWin || '0') || null,
    avg_loss: parseFloat(stats.avgLoss || '0') ? -Math.abs(parseFloat(stats.avgLoss)) : null,
    largest_win: parseFloat(stats.largestProfit || '0') || null,
    largest_loss: parseFloat(stats.largestLoss || '0') ? -Math.abs(parseFloat(stats.largestLoss)) : null,
    sharpe_ratio: null,
    max_drawdown: parseFloat(stats.maxRetracement || '0') || null,
    copiers_count: parseInt(stats.totalFollowers || '0') || null,
    copiers_pnl: parseFloat(stats.totalFollowProfit || '0') || null,
    aum: parseFloat(stats.aum || '0') || null,
    winning_positions: parseInt(stats.profitTrades || '0') || null,
    total_positions: parseInt(stats.totalTrades || '0') || null,
    captured_at: now,
  }
  
  await sb.from('trader_stats_detail')
    .delete().eq('source', SOURCE).eq('source_trader_id', traderId).eq('period', period)
  const { error } = await sb.from('trader_stats_detail').insert(row)
  if (error) { console.log(`  ⚠ stats: ${error.message}`); return 0 }
  return 1
}

async function upsertAssetBreakdown(traderId, period, symbols) {
  if (!symbols?.length) return 0
  const now = new Date().toISOString()
  const total = symbols.reduce((s, item) => s + parseInt(item.amount || '1'), 0) || symbols.length
  const rows = symbols.map(s => ({
    source: SOURCE, source_trader_id: traderId, period,
    symbol: (s.displayName || s.symbolName || 'UNKNOWN').replace('USDT', ''),
    weight_pct: (parseInt(s.amount || '1') / total) * 100,
    captured_at: now,
  }))
  const { error } = await sb.from('trader_asset_breakdown')
    .upsert(rows, { onConflict: 'source,source_trader_id,period,symbol,captured_at' })
  if (error) { console.log(`  ⚠ assets: ${error.message}`); return 0 }
  return rows.length
}

// ============================================
// Main
// ============================================
async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Bitget Futures Detail Enrichment (browser)`)
  console.log(`Limit: ${LIMIT}, Offset: ${OFFSET}`)
  console.log(`${'='.repeat(60)}`)

  // Get traders needing enrichment
  const { data: traders } = await sb.from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', SOURCE).eq('is_active', true)
    .limit(LIMIT + OFFSET)

  if (!traders?.length) { console.log('No traders found'); return }

  const ids = traders.map(t => t.source_trader_id)
  const { data: existingStats } = await sb.from('trader_stats_detail')
    .select('source_trader_id').eq('source', SOURCE).in('source_trader_id', ids.slice(0, 500))
  const hasStats = new Set(existingStats?.map(e => e.source_trader_id) || [])

  // Filter to valid hex trader IDs (skip synthetic ones like @BGUSER-xxx)
  const valid = traders.filter(t => /^[a-f0-9]{10,}$/.test(t.source_trader_id) && !hasStats.has(t.source_trader_id))
  const toProcess = valid.slice(OFFSET, OFFSET + LIMIT)

  console.log(`Total: ${traders.length}, valid hex IDs: ${valid.length}, has stats: ${hasStats.size}, to process: ${toProcess.length}`)

  if (toProcess.length === 0) { console.log('Nothing to do!'); return }

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  let statsN = 0, equityN = 0, assetsN = 0, errors = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // Visit bitget.com first to get cookies/CF clearance
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

    console.log('✅ Browser ready, starting enrichment...')

    for (let i = 0; i < toProcess.length; i++) {
      const tid = toProcess[i].source_trader_id
      
      try {
        // Fetch cycleData for each period
        for (const [period, cycleTime] of Object.entries(CYCLE_MAP)) {
          const cycleResult = await page.evaluate(async (uid, ct) => {
            try {
              const r = await fetch('/v1/trigger/trace/public/cycleData', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime: ct }),
              })
              return await r.json()
            } catch { return null }
          }, tid, cycleTime)

          if (cycleResult?.code === '00000' && cycleResult.data) {
            const d = cycleResult.data
            
            // Equity curve from roiRows
            if (d.roiRows?.rows?.length > 0) {
              const en = await upsertEquityCurve(tid, period, d.roiRows.rows)
              if (en > 0) equityN++
            }
            
            // Stats from statisticsDTO
            if (d.statisticsDTO) {
              const sn = await upsertStats(tid, period, d.statisticsDTO)
              if (sn > 0) statsN++
            }
            
            // Asset breakdown from symbolDistributeDetail
            if (d.symbolDistributeDetail?.webSymbolDistributeVOs?.length > 0) {
              const an = await upsertAssetBreakdown(tid, period, d.symbolDistributeDetail.webSymbolDistributeVOs)
              if (an > 0) assetsN++
            }
          }
          
          await sleep(500 + Math.random() * 300)
        }
      } catch (e) { errors++ }

      if ((i + 1) % 10 === 0 || i === toProcess.length - 1) {
        const pct = ((i + 1) / toProcess.length * 100).toFixed(0)
        console.log(`  [${i + 1}/${toProcess.length}] ${pct}% | stats=${statsN} eq=${equityN} assets=${assetsN} err=${errors}`)
      }
      
      await sleep(800 + Math.random() * 400)
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Bitget Futures enrichment done`)
  console.log(`   Stats: ${statsN}, Equity: ${equityN}, Assets: ${assetsN}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

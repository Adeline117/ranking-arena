#!/usr/bin/env node
/**
 * Bybit Position History Enrichment (Browser-based)
 * 
 * Fetches current and historical positions for Bybit copy-trading leaders.
 * Bybit's position APIs are behind Akamai bot protection, so we use
 * puppeteer with stealth to call internal APIs via page.evaluate.
 * 
 * APIs (via browser context):
 *   /x-api/fapi/beehive/public/v1/common/order/list-detail → position history
 * 
 * Usage: node scripts/import/enrich_bybit_positions.mjs [--limit=100]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { sb, sleep } from './lib/index.mjs'

puppeteer.use(StealthPlugin())

const SOURCE = 'bybit'

const limitArg = process.argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 200

// ============================================
// DB helpers
// ============================================
async function upsertPositionHistory(traderId, positions) {
  if (!positions?.length) return 0
  const now = new Date().toISOString()

  const records = positions.map(p => ({
    source: SOURCE,
    source_trader_id: traderId,
    symbol: p.symbol,
    direction: p.direction,
    position_type: 'perpetual',
    margin_mode: p.margin_mode || 'cross',
    open_time: p.open_time || null,
    close_time: p.close_time || null,
    entry_price: p.entry_price,
    exit_price: p.exit_price,
    max_position_size: p.max_position_size,
    closed_size: p.closed_size,
    pnl_usd: p.pnl_usd,
    pnl_pct: p.pnl_pct,
    status: p.status || 'closed',
    captured_at: now,
  })).filter(r => r.symbol && r.symbol !== 'UNKNOWN')

  if (records.length === 0) return 0

  // Delete recent entries for this trader (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await sb.from('trader_position_history')
    .delete()
    .eq('source', SOURCE)
    .eq('source_trader_id', traderId)
    .gt('captured_at', sevenDaysAgo)

  // Insert in batches
  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100)
    const { error } = await sb.from('trader_position_history').insert(batch)
    if (error) { console.log(`  ⚠ insert error: ${error.message}`); return 0 }
  }
  return records.length
}

// ============================================
// Main
// ============================================
async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Bybit Position History Enrichment (Browser-based)`)
  console.log(`${'='.repeat(60)}`)

  // Get Bybit traders
  const { data: traders } = await sb.from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', SOURCE)
    .limit(LIMIT * 3)

  if (!traders?.length) { console.log('No Bybit traders found'); return }

  const uniqueIds = [...new Set(traders.map(t => t.source_trader_id))]
  const toProcess = uniqueIds.slice(0, LIMIT)
  console.log(`Total unique traders: ${uniqueIds.length}, processing: ${toProcess.length}`)

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    timeout: 60000,
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  // Get session/cookies
  console.log('🌐 Getting Akamai clearance...')
  try {
    await page.goto('https://www.bybit.com/copyTrade/trade-center/find', { waitUntil: 'networkidle2', timeout: 45000 })
  } catch {
    console.log('  ⚠ Page load timeout, continuing...')
  }
  await sleep(3000)

  // Close popups
  await page.evaluate(() => {
    document.querySelectorAll('button, div, span').forEach(el => {
      const text = (el.textContent || '').toLowerCase()
      if (text.includes('confirm') || text.includes('accept') || text.includes('got it') || text.includes('ok')) {
        try { el.click() } catch {}
      }
    })
  }).catch(() => {})
  await sleep(1000)

  console.log('✅ Browser ready, starting position enrichment...')

  let totalPositions = 0, tradersWithData = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < toProcess.length; i++) {
    const tid = toProcess[i]
    const displayId = tid.length > 15 ? tid.slice(0, 12) + '...' : tid

    try {
      // Fetch order/position history via browser
      const result = await page.evaluate(async (leaderMark) => {
        try {
          const positions = []
          const enc = encodeURIComponent(leaderMark)

          // Try order list detail (closed positions)
          for (let pageNo = 1; pageNo <= 5; pageNo++) {
            const resp = await fetch(
              `/x-api/fapi/beehive/public/v1/common/order/list-detail?leaderMark=${enc}&pageNo=${pageNo}&pageSize=50`,
              { headers: { 'Accept': 'application/json' } }
            )
            if (!resp.ok) break
            const json = await resp.json()
            if (json.retCode !== 0 || !json.result?.data?.length) break

            for (const order of json.result.data) {
              const size = parseFloat(order.size || order.qty || '0')
              const entryPx = parseFloat(order.entryPrice || '0')
              const closePx = parseFloat(order.closePrice || order.exitPrice || '0')
              const pnl = parseFloat(order.closedPnl || order.realisedPnl || '0')

              positions.push({
                symbol: order.symbol || order.coin || 'UNKNOWN',
                direction: (order.side === 'Buy' || order.side === 'Long') ? 'long' : 'short',
                entry_price: entryPx || null,
                exit_price: closePx || null,
                max_position_size: size || null,
                closed_size: size || null,
                pnl_usd: pnl || null,
                pnl_pct: order.yieldRate ? parseFloat(order.yieldRate) * 100 : null,
                margin_mode: order.isIsolated ? 'isolated' : 'cross',
                status: 'closed',
                open_time: order.createdAtE3 ? new Date(parseInt(order.createdAtE3)).toISOString() :
                           order.openTime ? new Date(parseInt(order.openTime)).toISOString() : null,
                close_time: order.closedTime ? new Date(parseInt(order.closedTime)).toISOString() :
                            order.updatedAtE3 ? new Date(parseInt(order.updatedAtE3)).toISOString() : null,
              })
            }

            if (json.result.data.length < 50) break
          }

          return { positions, error: null }
        } catch (e) {
          return { positions: [], error: e.message }
        }
      }, tid)

      if (result.error) {
        errors++
        if (errors <= 5) console.log(`  ⚠ ${displayId}: ${result.error}`)
      }

      if (result.positions?.length > 0) {
        const saved = await upsertPositionHistory(tid, result.positions)
        if (saved > 0) {
          tradersWithData++
          totalPositions += saved
        }
      }
    } catch (e) {
      errors++
      if (errors <= 5) console.log(`  ⚠ ${displayId}: ${e.message}`)
    }

    await sleep(300 + Math.random() * 200)

    if ((i + 1) % 20 === 0 || i === toProcess.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      console.log(`  [${i + 1}/${toProcess.length}] traders=${tradersWithData} positions=${totalPositions} err=${errors} | ${elapsed}m`)
    }
  }

  await browser.close()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Bybit position enrichment done`)
  console.log(`   Traders with data: ${tradersWithData}, Positions: ${totalPositions}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

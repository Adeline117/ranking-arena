#!/usr/bin/env node
/**
 * Bitget Futures Position History Enrichment (Browser-based)
 * 
 * Fetches current and historical positions for Bitget copy-trading leaders.
 * Bitget is behind Cloudflare, so we use puppeteer with stealth plugin.
 * 
 * APIs (via browser context):
 *   POST /v1/trigger/trace/public/traderPositionHisList → closed positions
 *   POST /v1/trigger/trace/public/currentTrack → current open positions
 * 
 * Usage: node scripts/import/enrich_bitget_positions.mjs [--limit=100]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { sb, sleep } from './lib/index.mjs'

puppeteer.use(StealthPlugin())

const SOURCE = 'bitget_futures'

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

  // Delete recent entries for this trader
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await sb.from('trader_position_history')
    .delete()
    .eq('source', SOURCE)
    .eq('source_trader_id', traderId)
    .gt('captured_at', sevenDaysAgo)

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
  console.log(`Bitget Futures Position History Enrichment (Browser-based)`)
  console.log(`${'='.repeat(60)}`)

  // Get Bitget futures traders
  const { data: traders } = await sb.from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', SOURCE)
    .limit(LIMIT * 3)

  if (!traders?.length) { console.log('No Bitget futures traders found'); return }

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

  // Get Cloudflare clearance
  console.log('🌐 Getting Cloudflare clearance...')
  try {
    await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 })
  } catch {
    console.log('  ⚠ Page load timeout, continuing...')
  }
  await sleep(5000)

  // Close popups
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach(btn => {
      const text = (btn.textContent || '').toLowerCase()
      if (text.includes('ok') || text.includes('got') || text.includes('accept')) {
        try { btn.click() } catch {}
      }
    })
  }).catch(() => {})
  await sleep(1000)

  console.log('✅ Browser ready, starting position enrichment...')

  let totalPositions = 0, tradersWithData = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < toProcess.length; i++) {
    const tid = toProcess[i]

    try {
      const result = await page.evaluate(async (traderId) => {
        const positions = []

        // 1. Fetch current open positions
        try {
          const currentResp = await fetch('/v1/trigger/trace/public/currentTrack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ triggerUserId: traderId, languageType: 0, pageNo: 1, pageSize: 50 }),
          })
          const currentJson = await currentResp.json()
          if (currentJson?.code === '00000' && currentJson.data?.list?.length) {
            for (const pos of currentJson.data.list) {
              positions.push({
                symbol: pos.symbolName || pos.symbol || 'UNKNOWN',
                direction: pos.holdSide === 'long' ? 'long' : 'short',
                entry_price: parseFloat(pos.openPrice || pos.averageOpenPrice || '0') || null,
                exit_price: null,
                max_position_size: parseFloat(pos.holdAmount || pos.openSize || '0') || null,
                closed_size: null,
                pnl_usd: parseFloat(pos.achievedProfits || pos.unrealizedPL || '0') || null,
                pnl_pct: pos.yieldRate ? parseFloat(pos.yieldRate) * 100 : null,
                margin_mode: pos.marginMode === 'isolated' ? 'isolated' : 'cross',
                status: 'open',
                open_time: pos.openTime ? new Date(parseInt(pos.openTime)).toISOString() : null,
                close_time: null,
              })
            }
          }
        } catch {}

        // 2. Fetch closed position history (multiple pages)
        try {
          for (let pageNo = 1; pageNo <= 5; pageNo++) {
            const histResp = await fetch('/v1/trigger/trace/public/traderPositionHisList', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                triggerUserId: traderId,
                languageType: 0,
                pageNo,
                pageSize: 50,
              }),
            })
            const histJson = await histResp.json()
            if (histJson?.code !== '00000' || !histJson.data?.list?.length) break

            for (const pos of histJson.data.list) {
              positions.push({
                symbol: pos.symbolName || pos.symbol || 'UNKNOWN',
                direction: pos.holdSide === 'long' ? 'long' : 'short',
                entry_price: parseFloat(pos.openPrice || pos.averageOpenPrice || '0') || null,
                exit_price: parseFloat(pos.closePrice || pos.averageClosePrice || '0') || null,
                max_position_size: parseFloat(pos.openSize || pos.holdAmount || '0') || null,
                closed_size: parseFloat(pos.closeSize || pos.holdAmount || '0') || null,
                pnl_usd: parseFloat(pos.achievedProfits || pos.netProfit || '0') || null,
                pnl_pct: pos.yieldRate ? parseFloat(pos.yieldRate) * 100 : null,
                margin_mode: pos.marginMode === 'isolated' ? 'isolated' : 'cross',
                status: 'closed',
                open_time: pos.openTime ? new Date(parseInt(pos.openTime)).toISOString() : null,
                close_time: pos.closeTime ? new Date(parseInt(pos.closeTime)).toISOString() : null,
              })
            }

            if (histJson.data.list.length < 50) break
          }
        } catch {}

        return { positions, error: null }
      }, tid)

      if (result.positions?.length > 0) {
        const saved = await upsertPositionHistory(tid, result.positions)
        if (saved > 0) {
          tradersWithData++
          totalPositions += saved
        }
      }
    } catch (e) {
      errors++
      if (errors <= 5) console.log(`  ⚠ ${tid}: ${e.message}`)
    }

    await sleep(400 + Math.random() * 300)

    if ((i + 1) % 20 === 0 || i === toProcess.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      console.log(`  [${i + 1}/${toProcess.length}] traders=${tradersWithData} positions=${totalPositions} err=${errors} | ${elapsed}m`)
    }
  }

  await browser.close()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Bitget position enrichment done`)
  console.log(`   Traders with data: ${tradersWithData}, Positions: ${totalPositions}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

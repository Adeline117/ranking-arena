#!/usr/bin/env node
/**
 * Bybit Position Fetcher - Puppeteer to bypass WAF, then API calls
 * 
 * Usage: node scripts/fetch/fetch_positions_bybit.mjs [--limit=200]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTraders() {
  const ids = new Set()
  let offset = 0
  while (true) {
    const { data } = await sb.from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', 'bybit')
      .in('season_id', ['7D','30D','90D'])
      .range(offset, offset + 999)
    if (!data?.length) break
    data.forEach(t => { if (t.source_trader_id) ids.add(t.source_trader_id) })
    offset += 1000
    if (data.length < 1000) break
  }
  return [...ids].slice(0, LIMIT)
}

async function main() {
  console.log(`\n🔵 Bybit Position Fetcher`)
  console.log(`  Limit: ${LIMIT}`)

  const traders = await getTraders()
  console.log(`  Traders: ${traders.length}`)

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  // Navigate to a trader detail page to establish session
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  try {
    await page.goto(
      `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${encodeURIComponent(traders[0])}`,
      { waitUntil: 'networkidle2', timeout: 30000 }
    )
  } catch {}
  await sleep(3000)

  // Extract cookies for direct fetch
  const cookies = await browser.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  
  await browser.close()
  
  console.log(`  Session established, fetching positions via HTTP...\n`)

  // Now use direct fetch with cookies
  let withData = 0, totalPos = 0, errors = 0
  const t0 = Date.now()
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    try {
      const url = `https://www.bybit.com/x-api/fapi/beehive/public/v1/common/position/list?leaderMark=${encodeURIComponent(tid)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Cookie': cookieStr, 'Referer': 'https://www.bybit.com/copyTrade' },
        signal: AbortSignal.timeout(10000),
      })
      
      if (res.status === 403) {
        console.log(`  ⚠ WAF blocked at trader #${i + 1}, stopping`)
        break
      }
      
      const data = await res.json()
      const positions = data?.result?.data || []

      if (positions.length > 0) {
        const now = new Date().toISOString()
        const records = positions.map(p => ({
          source: 'bybit',
          source_trader_id: tid,
          symbol: (p.symbol || '').replace('USDT', ''),
          direction: p.side === 'Sell' ? 'short' : 'long',
          position_type: 'perpetual',
          margin_mode: p.crossSeq ? 'cross' : 'isolated',
          entry_price: parseFloat(p.entryPrice || '0') || null,
          max_position_size: parseFloat(p.positionValue || p.size || '0') || null,
          pnl_usd: parseFloat(p.unrealisedPnl || '0') || null,
          status: 'open',
          captured_at: now,
        })).filter(r => r.symbol)

        if (records.length) {
          const oneDayAgo = new Date(Date.now() - 86400000).toISOString()
          await sb.from('trader_position_history').delete()
            .eq('source', 'bybit').eq('source_trader_id', tid).gt('captured_at', oneDayAgo)
          const { error } = await sb.from('trader_position_history').insert(records)
          if (!error) { withData++; totalPos += records.length }
          else console.error(`  ⚠ ${tid.slice(0, 15)}: ${error.message}`)
        }
      }

      if (i < 5) console.log(`  #${i + 1} ${tid.slice(0, 20)} → ${positions.length} pos`)
    } catch (e) {
      errors++
      if (errors <= 3) console.error(`  ⚠ ${tid.slice(0, 15)}: ${e.message}`)
      if (errors > 10) { console.log('  Too many errors, stopping'); break }
    }
    await sleep(500)

    if ((i + 1) % 50 === 0 || i === traders.length - 1) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1)
      console.log(`  [${i + 1}/${traders.length}] withData=${withData} pos=${totalPos} err=${errors} | ${mins}m`)
    }
  }

  console.log(`\n✅ Bybit Done: ${withData} traders, ${totalPos} positions, ${errors} errors`)
}

main().catch(console.error)

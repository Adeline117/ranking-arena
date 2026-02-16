#!/usr/bin/env node
/**
 * Phemex Enrichment via Playwright
 * Visits copy trading profile pages and intercepts API responses
 * 
 * Usage: node scripts/enrich-phemex.mjs [--limit=200]
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '300')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const parseNum = v => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n }

async function enrichTrader(page, traderId) {
  const captured = { data: null }
  
  const handler = async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    try {
      // Capture any copy-trade related API response
      if (url.includes('copy-trade') && (url.includes('leader') || url.includes('trader') || url.includes('detail') || url.includes('overview') || url.includes('statistic'))) {
        const body = await resp.json()
        if (body.data || body.result) {
          if (!captured.data) captured.data = {}
          Object.assign(captured.data, body.data || body.result || {})
        }
      }
    } catch {}
  }
  
  page.on('response', handler)
  
  try {
    // Try different URL patterns for Phemex copy trading
    await page.goto(
      `https://phemex.com/copy-trade/leader/${traderId}`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    )
    for (let i = 0; i < 12; i++) {
      if (captured.data) break
      await sleep(500)
    }
  } catch {}
  
  page.removeListener('response', handler)
  return captured.data
}

function extractStats(data) {
  if (!data) return null
  
  // Look for common field patterns in Phemex API responses
  let wr = parseNum(data.winRate || data.win_rate || data.winRatio)
  let mdd = parseNum(data.maxDrawdown || data.max_drawdown || data.maxRetrace || data.maxRetracement)
  let tc = parseNum(data.totalTrades || data.trades_count || data.tradeCount || data.totalTradeNum)
  
  // Normalize
  if (wr != null && wr > 0 && wr <= 1) wr *= 100
  if (mdd != null) { mdd = Math.abs(mdd); if (mdd > 0 && mdd <= 1) mdd *= 100 }
  
  return (wr != null || mdd != null || tc != null) ? { wr, mdd, tc } : null
}

async function main() {
  console.log(`🔄 Phemex Enrichment (limit=${LIMIT})`)
  
  const { data: allRows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown, trades_count, arena_score')
    .eq('source', 'phemex')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .order('arena_score', { ascending: false })
  
  if (error) { console.error(error.message); process.exit(1) }
  
  const seen = new Set()
  const traders = allRows.filter(r => {
    if (seen.has(r.source_trader_id)) return false
    seen.add(r.source_trader_id)
    return true
  }).slice(0, LIMIT)
  
  console.log(`Found ${traders.length} unique traders to enrich\n`)
  
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', route => route.abort())

  // First, test a few URL patterns to find the working one
  console.log('Testing URL patterns...')
  const testId = traders[0]?.source_trader_id
  if (!testId) { console.log('No traders'); process.exit(0) }
  
  const patterns = [
    `https://phemex.com/copy-trade/leader/${testId}`,
    `https://phemex.com/copy-trade/trader/${testId}`,
    `https://phemex.com/copy-trading/trader/${testId}`,
    `https://phemex.com/copy-trade?uid=${testId}`,
  ]
  
  let workingPattern = null
  for (const pattern of patterns) {
    try {
      const resp = await page.goto(pattern, { waitUntil: 'domcontentloaded', timeout: 15000 })
      const title = await page.title()
      console.log(`  ${pattern} -> ${resp?.status()} "${title.slice(0, 50)}"`)
      if (!title.includes('404') && !title.includes('Not Found')) {
        workingPattern = pattern.replace(testId, '{ID}')
        break
      }
    } catch (e) {
      console.log(`  ${pattern} -> ERROR: ${e.message.slice(0, 50)}`)
    }
  }
  
  if (!workingPattern) {
    console.log('\n❌ No working URL pattern found for Phemex. Try browser scraping manually.')
    await browser.close()
    process.exit(1)
  }
  
  console.log(`\nUsing pattern: ${workingPattern}\n`)
  
  let enriched = 0, failed = 0
  
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    process.stdout.write(`[${i+1}/${traders.length}] ${t.source_trader_id} (${t.handle?.slice(0,15)}) ... `)
    
    try {
      const data = await enrichTrader(page, t.source_trader_id)
      const stats = extractStats(data)
      
      if (stats) {
        const updates = {}
        if (stats.wr != null) updates.win_rate = stats.wr
        if (stats.mdd != null) updates.max_drawdown = stats.mdd
        if (stats.tc != null) updates.trades_count = stats.tc
        
        if (Object.keys(updates).length) {
          await sb.from('leaderboard_ranks').update(updates)
            .eq('source', 'phemex').eq('source_trader_id', t.source_trader_id)
          await sb.from('trader_snapshots').update(updates)
            .eq('source', 'phemex').eq('source_trader_id', t.source_trader_id)
          console.log(`✅ WR=${stats.wr} MDD=${stats.mdd} TC=${stats.tc}`)
          enriched++
        } else {
          console.log('⚠️ no useful data')
          failed++
        }
      } else {
        console.log('⚠️ no data captured')
        failed++
      }
    } catch (e) {
      console.log(`❌ ${e.message?.slice(0, 60)}`)
      failed++
    }
    
    await sleep(2000)
    
    // Stop early if too many failures (API not working)
    if (i >= 10 && enriched === 0) {
      console.log('\n⛔ 10 attempts with 0 enrichments. Stopping - API pattern needs investigation.')
      break
    }
  }
  
  await browser.close()
  console.log(`\nDone: ${enriched} enriched, ${failed} failed`)
}

main().catch(e => { console.error(e); process.exit(1) })

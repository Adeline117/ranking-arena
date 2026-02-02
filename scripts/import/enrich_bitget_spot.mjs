/**
 * Bitget Spot Data Enrichment (Browser-based)
 * 
 * Fills missing win_rate for existing bitget_spot traders.
 * 
 * Usage: node scripts/import/enrich_bitget_spot.mjs [30D] [--batch=50] [--offset=0]
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())
const supabase = getSupabaseClient()
const SOURCE = 'bitget_spot'

function parseArgs() {
  const period = (process.argv[2] || '30D').toUpperCase()
  let batch = 50, offset = 0
  for (const arg of process.argv) {
    if (arg.startsWith('--batch=')) batch = parseInt(arg.split('=')[1])
    if (arg.startsWith('--offset=')) offset = parseInt(arg.split('=')[1])
  }
  return { period, batch, offset }
}

async function extractTraderData(page, traderId, period) {
  // Skip synthetic IDs
  if (traderId.startsWith('spot_')) return { winRate: null, maxDrawdown: null }

  const details = {}

  try {
    await page.goto(`https://www.bitget.com/copy-trading/trader/${traderId}/spot`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    }).catch(() => {})

    await Promise.race([
      page.waitForSelector('[class*="roi"], [class*="data"]', { timeout: 8000 }),
      sleep(5000)
    ]).catch(() => {})

    // Click period tab
    const periodMap = { '7D': '7', '30D': '30', '90D': '90' }
    await page.evaluate((days) => {
      const buttons = document.querySelectorAll('button, [role="tab"], div[class*="tab"]')
      for (const btn of buttons) {
        const text = btn.textContent || ''
        if (text.includes(days + 'D') || text.includes(days + ' day')) {
          btn.click(); return
        }
      }
    }, periodMap[period])
    await sleep(1500)

    const pageData = await page.evaluate(() => {
      const text = document.body.innerText
      const result = {}
      const winMatch = text.match(/(?:Win rate|胜率)[\s\n:]*(\d+\.?\d*)%/i)
      if (winMatch) result.winRate = parseFloat(winMatch[1])
      const mddMatch = text.match(/(?:MDD|Max(?:imum)? ?[Dd]rawdown|最大回撤)[\s\n:]*(\d+\.?\d*)%/i)
      if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])
      return result
    })

    Object.assign(details, pageData)
  } catch {}

  return {
    winRate: details.winRate ?? null,
    maxDrawdown: details.maxDrawdown ?? null,
  }
}

async function main() {
  const { period, batch, offset } = parseArgs()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Bitget Spot Enrichment — ${period} (batch=${batch}, offset=${offset})`)
  console.log(`${'='.repeat(60)}`)

  const { data: missing } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .eq('season_id', period)
    .is('win_rate', null)
    .order('roi', { ascending: false })
    .range(offset, offset + batch - 1)

  if (!missing || missing.length === 0) {
    console.log('Nothing to enrich!')
    return
  }

  // Filter valid trader IDs (hex format, not synthetic)
  const validTraders = missing.filter(t => !t.source_trader_id.startsWith('spot_') && /^[a-f0-9]+$/.test(t.source_trader_id))
  console.log(`Processing ${validTraders.length} valid traders (of ${missing.length} total, offset ${offset})...`)

  if (validTraders.length === 0) {
    console.log('No valid trader IDs to process.')
    return
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  })

  let wrFilled = 0, ddFilled = 0, errors = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')

    for (let i = 0; i < validTraders.length; i++) {
      const trader = validTraders[i]
      try {
        const data = await extractTraderData(page, trader.source_trader_id, period)

        const newWr = data.winRate !== null ? (data.winRate <= 1 ? data.winRate * 100 : data.winRate) : null
        const newDd = data.maxDrawdown !== null && trader.max_drawdown === null ? data.maxDrawdown : trader.max_drawdown

        if (newWr !== null || (newDd !== null && trader.max_drawdown === null)) {
          const { totalScore } = calculateArenaScore(trader.roi || 0, trader.pnl, newDd, newWr, period)
          const update = { arena_score: totalScore }
          if (newWr !== null) { update.win_rate = newWr; wrFilled++ }
          if (newDd !== null && trader.max_drawdown === null) { update.max_drawdown = newDd; ddFilled++ }

          await supabase.from('trader_snapshots').update(update).eq('id', trader.id)
        }
      } catch (e) { errors++ }

      if ((i + 1) % 10 === 0 || i === validTraders.length - 1) {
        console.log(`  [${i + 1}/${validTraders.length}] wr+=${wrFilled} dd+=${ddFilled} err=${errors}`)
      }

      await sleep(1500 + Math.random() * 1000)
    }

    await page.close()
  } finally {
    await browser.close()
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Bitget Spot ${period} enrichment done`)
  console.log(`   Win rate filled: ${wrFilled}/${validTraders.length}`)
  console.log(`   Max drawdown filled: ${ddFilled}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

/**
 * Enrich Bitget Spot & Futures traders with missing WR/MDD/TC data
 * Usage: node scripts/enrich_bitget.mjs [spot|futures|both]
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
} from './lib/shared.mjs'

puppeteer.use(StealthPlugin())
const supabase = getSupabaseClient()
const mode = process.argv[2] || 'both'

async function getTradersMissingData(source) {
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, win_rate, max_drawdown, trades_count, roi, pnl')
    .eq('source', source)
    .eq('season_id', '90D')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .limit(1000)
  
  if (error) throw error
  console.log(`[${source}] Found ${data.length} traders needing enrichment`)
  return data
}

async function fetchTraderDetails(page, traderId, type) {
  let apiDetails = {}
  
  const responseHandler = async (res) => {
    const url = res.url()
    try {
      if (url.includes('api') && (url.includes('trader') || url.includes('copy'))) {
        const text = await res.text().catch(() => '')
        if (text.includes('"data"') && (text.includes('winRate') || text.includes('winRatio') || text.includes('maxDrawdown') || text.includes('totalOrder'))) {
          try {
            const json = JSON.parse(text)
            if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
              Object.assign(apiDetails, json.data)
            }
          } catch {}
        }
      }
    } catch {}
  }

  page.on('response', responseHandler)

  try {
    const suffix = type === 'bitget_spot' ? 'spot' : 'futures'
    const url = `https://www.bitget.com/copy-trading/trader/${traderId}/${suffix}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})

    await sleep(4000)

    // Click 90D tab
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, [role="tab"], div[class*="tab"]')
      for (const btn of buttons) {
        const text = btn.textContent || ''
        if (text.includes('90D') || text.includes('90 day')) {
          btn.click()
          return
        }
      }
    }).catch(() => {})
    await sleep(2000)

    // Extract from page text
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText
      const result = {}

      const winMatch = text.match(/(?:Win rate|胜率)[\s\n:]*(\d+\.?\d*)%/i)
      if (winMatch) result.winRate = parseFloat(winMatch[1])

      const mddMatch = text.match(/(?:MDD|Max(?:imum)?\s*[Dd]rawdown|最大回撤)[\s\n:]*(\d+\.?\d*)%/i)
      if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])

      // Try various patterns for trade count
      const tradeMatch = text.match(/(?:Total orders?|Total trades?|Trades?|总交易|交易次数|订单数)[\s\n:]*(\d+)/i)
      if (tradeMatch) result.tradesCount = parseInt(tradeMatch[1])

      return result
    }).catch(() => ({}))

    Object.assign(apiDetails, pageData)
  } catch (e) {
    // ignore
  } finally {
    page.off('response', responseHandler)
  }

  return apiDetails
}

async function enrichSource(source) {
  const traders = await getTradersMissingData(source)
  if (traders.length === 0) {
    console.log(`[${source}] All traders already enriched!`)
    return { updated: 0, failed: 0 }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  // Use single page, reuse for all traders (avoid new page overhead + looks more human)
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })

  let updated = 0, failed = 0

  try {
    for (let i = 0; i < traders.length; i++) {
      const trader = traders[i]
      const traderId = trader.source_trader_id

      const details = await fetchTraderDetails(page, traderId, source)

      const update = {}
      
      // Win rate from page or API
      if (trader.win_rate == null) {
        const wr = details.winRate ?? (details.winRatio != null ? parseFloat(details.winRatio) * 100 : null)
        if (wr != null) update.win_rate = wr <= 1 && wr > 0 ? wr * 100 : wr
      }
      
      // Max drawdown
      if (trader.max_drawdown == null) {
        const mdd = details.maxDrawdown ?? details.maxDrawDown ?? details.mdd
        if (mdd != null) update.max_drawdown = parseFloat(mdd)
      }
      
      // Trades count
      if (trader.trades_count == null) {
        const tc = details.tradesCount ?? details.totalOrder ?? details.totalTrade ?? details.orderCount
        if (tc != null) update.trades_count = parseInt(tc)
      }

      if (Object.keys(update).length > 0) {
        const newWr = update.win_rate ?? trader.win_rate
        const newMdd = update.max_drawdown ?? trader.max_drawdown
        const roi = trader.roi ?? 0
        const pnl = trader.pnl ?? 0
        const score = calculateArenaScore(roi, pnl, newMdd, newWr, '90D')
        if (score?.totalScore) update.arena_score = score.totalScore

        const { error } = await supabase
          .from('trader_snapshots')
          .update(update)
          .eq('source', source)
          .eq('season_id', '90D')
          .eq('source_trader_id', traderId)

        if (error) {
          console.error(`  ✗ ${traderId}: ${error.message}`)
          failed++
        } else {
          updated++
          if (updated <= 5 || updated % 50 === 0) {
            console.log(`  ✓ ${traderId}: ${JSON.stringify(update)}`)
          }
        }
      } else {
        failed++
      }

      if ((i + 1) % 20 === 0) {
        console.log(`  [${source}] Progress: ${i + 1}/${traders.length} (updated: ${updated}, failed: ${failed})`)
      }

      // Random delay 2-5s between requests to avoid Cloudflare
      await sleep(2000 + Math.random() * 3000)
    }
  } finally {
    await browser.close()
  }

  console.log(`\n[${source}] Done: ${updated} updated, ${failed} failed out of ${traders.length}`)
  return { updated, failed }
}

async function main() {
  console.log('=== Bitget Enrichment Script ===')
  console.log(`Mode: ${mode}\n`)

  if (mode === 'spot' || mode === 'both') {
    await enrichSource('bitget_spot')
  }
  if (mode === 'futures' || mode === 'both') {
    await enrichSource('bitget_futures')
  }

  console.log('\n=== Done ===')
}

main().catch(console.error)

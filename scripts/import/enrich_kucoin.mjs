/**
 * KuCoin Data Enrichment (Browser-based)
 * 
 * Fills missing win_rate for existing kucoin traders.
 * Only 38 traders missing — uses browser to visit trader pages.
 * 
 * Usage: node scripts/import/enrich_kucoin.mjs [30D]
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())
const supabase = getSupabaseClient()
const SOURCE = 'kucoin'

async function main() {
  const period = (process.argv[2] || '30D').toUpperCase()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`KuCoin Enrichment — ${period}`)
  console.log(`${'='.repeat(60)}`)

  const { data: missing } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE)
    .eq('season_id', period)
    .is('win_rate', null)

  if (!missing || missing.length === 0) {
    console.log('Nothing to enrich!')
    return
  }

  console.log(`${missing.length} traders missing win_rate`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  let wrFilled = 0, errors = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')

    // Intercept API responses
    let lastApiData = null
    page.on('response', async (res) => {
      const url = res.url()
      if (url.includes('leader') && (url.includes('detail') || url.includes('info'))) {
        try {
          const json = await res.json()
          if (json.data) lastApiData = json.data
        } catch {}
      }
    })

    for (let i = 0; i < missing.length; i++) {
      const trader = missing[i]
      lastApiData = null

      try {
        const url = `https://www.kucoin.com/copytrading/leader/${trader.source_trader_id}`
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
        await sleep(4000)

        // Close any popups
        await page.evaluate(() => {
          document.querySelectorAll('button, [class*="close"]').forEach(btn => {
            const text = (btn.textContent || '').toLowerCase()
            if (text.includes('ok') || text.includes('got it') || text.includes('×')) {
              try { btn.click() } catch {}
            }
          })
        }).catch(() => {})
        await sleep(1000)

        // Extract from page
        const pageData = await page.evaluate(() => {
          const text = document.body.innerText
          const result = {}
          const winMatch = text.match(/(?:Win rate|Win ratio|胜率)[\s\n:]*(\d+\.?\d*)%/i)
          if (winMatch) result.winRate = parseFloat(winMatch[1])
          const mddMatch = text.match(/(?:Max.? ?[Dd]rawdown|MDD|最大回撤)[\s\n:]*(\d+\.?\d*)%/i)
          if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])
          return result
        })

        // Merge API data + page data
        const winRate = pageData.winRate ?? (lastApiData?.winRatio != null ? parseFloat(lastApiData.winRatio) * 100 : null)

        if (winRate !== null && winRate > 0) {
          const newDd = pageData.maxDrawdown ?? trader.max_drawdown
          const { totalScore } = calculateArenaScore(trader.roi || 0, trader.pnl, newDd, winRate, period)

          const update = { win_rate: winRate, arena_score: totalScore }
          if (pageData.maxDrawdown != null && trader.max_drawdown === null) {
            update.max_drawdown = pageData.maxDrawdown
          }

          await supabase.from('trader_snapshots').update(update).eq('id', trader.id)
          wrFilled++
        }
      } catch { errors++ }

      if ((i + 1) % 10 === 0 || i === missing.length - 1) {
        console.log(`  [${i + 1}/${missing.length}] wr+=${wrFilled} err=${errors}`)
      }

      await sleep(2000 + Math.random() * 1000)
    }

    await page.close()
  } finally {
    await browser.close()
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ KuCoin ${period} enrichment done`)
  console.log(`   Win rate filled: ${wrFilled}/${missing.length}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)

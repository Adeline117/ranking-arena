#!/usr/bin/env node
/**
 * Witness P3 serving modules on the LIVE site. Loads a MEXC trader (rich
 * ability_scores + hold_histogram + last_trade) and a bybit-copytrade trader
 * (sortino/volatility promotion), waits for the client-rendered serving panel,
 * and asserts the new module labels appear. Screenshots both. Polls until the
 * deploy that ships these labels is live (or times out).
 */
import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const BASE = process.env.WITNESS_BASE || 'https://www.arenafi.org'
const OUT = path.join(process.cwd(), 'scripts/screenshots/serving-p3')
fs.mkdirSync(OUT, { recursive: true })

const TARGETS = [
  {
    name: 'mexc',
    url: `${BASE}/trader/03934836?platform=mexc_futures`,
    expect: ['Trading Ability', 'Holding Duration', 'Last trade'],
  },
  {
    name: 'bybit-copytrade',
    url: `${BASE}/trader/${encodeURIComponent('4KoIQ30NOVo02Gc6KijcAw==')}?platform=bybit_copytrade`,
    expect: ['Last trade'],
  },
]

const DEADLINE = Date.now() + 9 * 60_000 // up to 9 min for the deploy

async function bodyText(page) {
  return (await page.evaluate(() => document.body.innerText)) || ''
}

async function run() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    locale: 'en-US',
  })
  const results = []

  for (const tgt of TARGETS) {
    let found = []
    let lastText = ''
    while (Date.now() < DEADLINE) {
      const page = await ctx.newPage()
      try {
        await page.goto(tgt.url, { waitUntil: 'networkidle', timeout: 30_000 })
        // serving panel is client-rendered after the /core fetch resolves
        await page.waitForTimeout(6000)
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await page.waitForTimeout(2500)
        lastText = await bodyText(page)
        found = tgt.expect.filter((s) => lastText.includes(s))
        if (found.length === tgt.expect.length) {
          await page.screenshot({
            path: path.join(OUT, `${tgt.name}.png`),
            fullPage: true,
          })
          await page.close()
          break
        }
      } catch (e) {
        lastText = `ERROR ${e.message}`
      }
      await page.close()
      console.log(`[${tgt.name}] waiting for deploy… found ${found.length}/${tgt.expect.length}`)
      await new Promise((r) => setTimeout(r, 20_000))
    }
    results.push({
      name: tgt.name,
      url: tgt.url,
      expected: tgt.expect,
      found,
      ok: found.length === tgt.expect.length,
    })
    console.log(
      `[${tgt.name}] ${found.length === tgt.expect.length ? '✅' : '❌'} found: ${found.join(', ') || '(none)'}`
    )
  }

  await browser.close()
  console.log('\n=== WITNESS RESULT ===')
  console.log(JSON.stringify(results, null, 2))
  const allOk = results.every((r) => r.ok)
  process.exit(allOk ? 0 : 1)
}

run().catch((e) => {
  console.error(e)
  process.exit(2)
})

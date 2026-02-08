#!/usr/bin/env node
/**
 * Test stealth scraper against WAF-protected exchanges
 * Usage: node scripts/test-stealth-scraper.mjs
 */

import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteerExtra.use(StealthPlugin())

const TARGETS = [
  { name: 'BloFin', url: 'https://blofin.com/en/copy-trade', patterns: ['copy', 'trader', 'rank'] },
  { name: 'BingX', url: 'https://bingx.com/en/CopyTrading/leaderBoard', patterns: ['copy', 'trader', 'ranking', 'leaderBoard'] },
]

const PROXY = process.env.STEALTH_PROXY || undefined

async function testTarget({ name, url, patterns }) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Testing: ${name} — ${url}`)
  console.log('='.repeat(60))

  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  if (PROXY) args.push(`--proxy-server=http://${PROXY}`)

  const browser = await puppeteerExtra.launch({ headless: 'new', args, defaultViewport: { width: 1440, height: 900 } })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')

    const apiResponses = []
    page.on('response', async (resp) => {
      const respUrl = resp.url()
      if (patterns.some(p => respUrl.includes(p))) {
        try {
          const body = await resp.text()
          apiResponses.push({ url: respUrl, status: resp.status(), bodyLen: body.length, preview: body.slice(0, 200) })
        } catch {}
      }
    })

    console.log('Navigating...')
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })

    // Wait for potential CF challenge
    await new Promise(r => setTimeout(r, 8000))

    const title = await page.title()
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '')
    const cookies = await page.cookies()

    console.log(`Title: ${title}`)
    console.log(`Body preview: ${bodyText.slice(0, 200)}`)
    console.log(`Cookies: ${cookies.length}`)
    console.log(`CF cookies: ${cookies.filter(c => c.name.startsWith('cf_') || c.name === '__cf_bm').map(c => c.name).join(', ') || 'none'}`)
    console.log(`API responses intercepted: ${apiResponses.length}`)

    for (const resp of apiResponses.slice(0, 5)) {
      console.log(`  → ${resp.status} ${resp.url.slice(0, 100)} (${resp.bodyLen} bytes)`)
      console.log(`    ${resp.preview.slice(0, 120)}`)
    }

    const blocked = title.toLowerCase().includes('just a moment') ||
      bodyText.includes('Checking your browser') ||
      bodyText.includes('Access Denied')

    console.log(`\nResult: ${blocked ? '❌ BLOCKED' : '✅ PASSED'}`)
    return !blocked
  } finally {
    await browser.close()
  }
}

async function main() {
  console.log('Stealth Scraper Test')
  console.log(`Proxy: ${PROXY || 'none'}`)

  let passed = 0
  for (const target of TARGETS) {
    try {
      if (await testTarget(target)) passed++
    } catch (err) {
      console.log(`❌ ${target.name} ERROR: ${err.message}`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Results: ${passed}/${TARGETS.length} passed`)
  process.exit(passed === TARGETS.length ? 0 : 1)
}

main()

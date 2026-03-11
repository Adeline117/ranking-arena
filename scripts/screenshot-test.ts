/**
 * Screenshot test — captures key pages to verify UI rendering
 * Usage: npx playwright test scripts/screenshot-test.ts
 */
import { chromium } from 'playwright'
import path from 'path'

const BASE = 'http://localhost:3000'
const OUT = path.join(__dirname, '..', 'screenshots')

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  })
  const page = await context.newPage()

  const fs = await import('fs')
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

  const screenshots: { name: string; url: string; wait?: number; action?: () => Promise<void> }[] = [
    { name: '01-homepage-rankings', url: '/', wait: 3000 },
    { name: '02-homepage-scroll-to-bots', url: '/', wait: 3000, action: async () => {
      // Bots are around rank 39-45, scroll down to see them
      await page.evaluate(() => window.scrollBy(0, 1200))
      await page.waitForTimeout(1000)
    }},
    { name: '03-gmx-rankings', url: '/rankings/gmx', wait: 3000 },
    { name: '03b-gmx-table-view', url: '/rankings/gmx', wait: 3000, action: async () => {
      // Click "Table" tab to switch to table view
      const tableBtn = await page.$('button:has-text("Table"), [role="tab"]:has-text("Table")')
      if (tableBtn) await tableBtn.click()
      await page.waitForTimeout(1000)
    }},
    { name: '04-hyperliquid-rankings', url: '/rankings/hyperliquid', wait: 3000 },
  ]

  for (const s of screenshots) {
    console.log(`Capturing: ${s.name} (${s.url})`)
    await page.goto(`${BASE}${s.url}`, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(s.wait || 2000)
    if (s.action) await s.action()
    await page.screenshot({ path: path.join(OUT, `${s.name}.png`), fullPage: false })
    console.log(`  Saved: screenshots/${s.name}.png`)
  }

  // Mobile view
  console.log('Capturing: 04-mobile-rankings')
  const mobilePage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
  })
  await mobilePage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 })
  await mobilePage.waitForTimeout(3000)
  await mobilePage.screenshot({ path: path.join(OUT, '04-mobile-rankings.png'), fullPage: false })
  console.log('  Saved: screenshots/04-mobile-rankings.png')

  await browser.close()
  console.log('\nDone! All screenshots saved to ./screenshots/')
}

main().catch(err => { console.error(err); process.exit(1) })

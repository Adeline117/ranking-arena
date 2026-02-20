/**
 * Arena — Screenshot all main pages (desktop + mobile)
 * Run from /Users/adelinewen/ranking-arena: node scripts/screenshot-all-pages.mjs
 */
import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const BASE = 'https://www.arenafi.org'
const OUT = '/tmp/arena-screenshots'

const PAGES = [
  { name: '01-homepage', url: '/' },
  { name: '02-market', url: '/market' },
  { name: '03-library', url: '/library' },
  { name: '04-institutions', url: '/rankings/institutions' },
  { name: '05-tools', url: '/rankings/tools' },
  { name: '06-pricing', url: '/pricing' },
  { name: '07-groups', url: '/groups' },
  { name: '08-hot', url: '/hot' },
]

fs.mkdirSync(`${OUT}/desktop`, { recursive: true })
fs.mkdirSync(`${OUT}/mobile`, { recursive: true })

async function shot(page, url, file) {
  try {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await page.waitForTimeout(3000)
    await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 85 })
    console.log('✓', path.basename(file))
  } catch (e) {
    console.error('✗', path.basename(file), e.message.slice(0, 60))
  }
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })

// ── Get a real trader URL from homepage ──────────
async function getTraderUrl() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pg = await ctx.newPage()
  try {
    await pg.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await pg.waitForTimeout(3000)
    const href = await pg.$eval('a[href*="/trader/"]', el => el.href).catch(() => null)
    return href ? new URL(href).pathname : '/trader/AlienTrade'
  } finally {
    await ctx.close()
  }
}

const traderPath = await getTraderUrl()
console.log('Using trader page:', traderPath)

// ── Desktop 1440×900 ────────────────────────────
console.log('\n── Desktop (1440×900) ──')
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pg = await ctx.newPage()
  for (const p of PAGES) await shot(pg, p.url, `${OUT}/desktop/${p.name}.jpg`)
  await shot(pg, traderPath, `${OUT}/desktop/09-trader-detail.jpg`)
  await ctx.close()
}

// ── Mobile 390×844 ──────────────────────────────
console.log('\n── Mobile (390×844) ──')
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  const pg = await ctx.newPage()
  for (const p of PAGES) await shot(pg, p.url, `${OUT}/mobile/${p.name}.jpg`)
  await shot(pg, traderPath, `${OUT}/mobile/09-trader-detail.jpg`)
  await ctx.close()
}

await browser.close()
console.log('\n✅ All screenshots done → /tmp/arena-screenshots/')

/**
 * Arena — Full screenshot matrix
 * 9 pages × 2 themes × 2 languages × 2 viewports = 72 screenshots
 */
import { chromium } from 'playwright'
import fs from 'fs'

const BASE = 'https://www.arenafi.org'
const OUT = '/tmp/arena-full-matrix'
fs.mkdirSync(OUT, { recursive: true })

const PAGES = [
  { name: '01-homepage',     url: '/' },
  { name: '02-market',       url: '/market' },
  { name: '03-library',      url: '/library' },
  { name: '04-institutions', url: '/rankings/institutions' },
  { name: '05-tools',        url: '/rankings/tools' },
  { name: '06-pricing',      url: '/pricing' },
  { name: '07-groups',       url: '/groups' },
  { name: '08-hot',          url: '/hot' },
  { name: '09-user-profile', url: '/u/Adeline' },
]

const THEMES = ['dark', 'light']
const LANGS  = ['zh', 'en']
const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900,  isMobile: false, dpr: 1 },
  { label: 'mobile',  width: 390,  height: 844, isMobile: true,  dpr: 2 },
]

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'

// Get a real trader URL
async function getTraderUrl(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pg  = await ctx.newPage()
  try {
    await pg.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await pg.waitForTimeout(2500)
    const href = await pg.$eval('a[href*="/trader/"]', el => el.href).catch(() => null)
    return href ? new URL(href).pathname : '/trader/AlienTrade'
  } finally { await ctx.close() }
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const traderPath = await getTraderUrl(browser)
console.log('Trader sample:', traderPath)

// Add trader detail as page 10
PAGES.push({ name: '10-trader-detail', url: traderPath })

let done = 0
const total = PAGES.length * THEMES.length * LANGS.length * VIEWPORTS.length

for (const theme of THEMES) {
  for (const lang of LANGS) {
    const dir = `${OUT}/${theme === 'dark' ? '深色' : '浅色'}-${lang === 'zh' ? '中文' : '英文'}`
    fs.mkdirSync(`${dir}/desktop`, { recursive: true })
    fs.mkdirSync(`${dir}/mobile`,  { recursive: true })

    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.dpr,
        isMobile: vp.isMobile,
        userAgent: vp.isMobile ? MOBILE_UA : undefined,
      })
      const page = await ctx.newPage()

      // Set localStorage before every navigation
      await page.addInitScript(({ theme, lang }) => {
        localStorage.setItem('theme', theme)
        localStorage.setItem('language', lang)
        localStorage.setItem('i18nextLng', lang)
        localStorage.setItem('arena-language', lang)
      }, { theme, lang })

      for (const p of PAGES) {
        const file = `${dir}/${vp.label}/${p.name}.jpg`
        try {
          await page.goto(BASE + p.url, { waitUntil: 'domcontentloaded', timeout: 25000 })
          await page.evaluate(({ theme, lang }) => {
            document.documentElement.setAttribute('data-theme', theme)
            document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
          }, { theme, lang })
          await page.waitForTimeout(2500)
          await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 85 })
          done++
          console.log(`[${done}/${total}] ✓ ${theme}/${lang}/${vp.label}/${p.name}`)
        } catch (e) {
          console.error(`✗ ${p.name}:`, e.message.slice(0, 80))
        }
      }
      await ctx.close()
    }
  }
}

await browser.close()
console.log(`\n✅ Done → ${OUT}`)

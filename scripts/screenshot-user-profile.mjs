/**
 * Arena — User profile screenshots: 2 themes × 2 languages = 4 shots
 * Run: node scripts/screenshot-user-profile.mjs
 */
import { chromium } from 'playwright'
import fs from 'fs'

const BASE = 'https://www.arenafi.org'
const USER_HANDLE = 'Adeline'
const OUT = '/tmp/arena-screenshots/user-profile'
fs.mkdirSync(OUT, { recursive: true })

const COMBOS = [
  { theme: 'dark',  lang: 'zh', label: '深色-中文' },
  { theme: 'dark',  lang: 'en', label: '深色-英文' },
  { theme: 'light', lang: 'zh', label: '浅色-中文' },
  { theme: 'light', lang: 'en', label: '浅色-英文' },
]

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })

for (const combo of COMBOS) {
  for (const vp of [
    { label: 'desktop', width: 1440, height: 900, isMobile: false },
    { label: 'mobile',  width: 390,  height: 844, isMobile: true  },
  ]) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.isMobile ? 2 : 1,
      isMobile: vp.isMobile,
      userAgent: vp.isMobile
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
        : undefined,
    })

    const page = await ctx.newPage()

    // Set localStorage BEFORE navigating
    await page.addInitScript(({ theme, lang }) => {
      localStorage.setItem('theme', theme)
      localStorage.setItem('language', lang)
      localStorage.setItem('i18nextLng', lang)
      localStorage.setItem('arena-language', lang)
    }, { theme: combo.theme, lang: combo.lang })

    await page.goto(`${BASE}/u/${USER_HANDLE}`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    })

    // Apply theme to html element
    await page.evaluate(({ theme, lang }) => {
      document.documentElement.setAttribute('data-theme', theme)
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    }, { theme: combo.theme, lang: combo.lang })

    // Wait for content to render
    await page.waitForTimeout(3000)

    const filename = `${OUT}/${combo.label}-${vp.label}.jpg`
    await page.screenshot({ path: filename, fullPage: true, type: 'jpeg', quality: 88 })
    console.log('✓', `${combo.label} / ${vp.label}`)

    await ctx.close()
  }
}

await browser.close()
console.log(`\n✅ 8 screenshots → ${OUT}`)

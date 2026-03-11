/**
 * Mobile UI screenshot test — captures all key mobile pages
 * Usage: node scripts/mobile-screenshot-test.mjs
 */
import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = 'http://localhost:3000'
const OUT = path.join(__dirname, '..', 'screenshots', 'mobile')

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

  const browser = await chromium.launch()

  // iPhone 14 Pro dimensions
  const page = await browser.newPage({
    viewport: { width: 393, height: 852 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })

  const screenshots = [
    // === Homepage / Rankings ===
    { name: 'm01-homepage-top', url: '/', wait: 4000 },
    { name: 'm02-homepage-scroll', url: '/', wait: 3000, action: async () => {
      await page.evaluate(() => window.scrollBy(0, 600))
      await page.waitForTimeout(1000)
    }},
    { name: 'm03-homepage-card-view', url: '/', wait: 3000, action: async () => {
      // Cards should auto-show on mobile, just scroll to see them
      await page.evaluate(() => window.scrollBy(0, 400))
      await page.waitForTimeout(1000)
    }},

    // === Exchange ranking page ===
    { name: 'm04-exchange-ranking', url: '/rankings/hyperliquid', wait: 3000 },

    // === Trader detail page ===
    { name: 'm05-trader-detail', url: '/trader/binance_futures:4830134122954965760', wait: 3000 },
    { name: 'm06-trader-detail-scroll', url: '/trader/binance_futures:4830134122954965760', wait: 3000, action: async () => {
      await page.evaluate(() => window.scrollBy(0, 500))
      await page.waitForTimeout(1000)
    }},
    { name: 'm07-trader-detail-tabs', url: '/trader/binance_futures:4830134122954965760', wait: 3000, action: async () => {
      // Try to click Stats tab
      const statsTab = await page.$('button:has-text("Stats"), [role="tab"]:has-text("Stats")')
      if (statsTab) await statsTab.click()
      await page.waitForTimeout(1500)
    }},

    // === Hot page ===
    { name: 'm08-hot-page', url: '/hot', wait: 3000 },

    // === Groups page ===
    { name: 'm09-groups-page', url: '/groups', wait: 3000 },

    // === Market page ===
    { name: 'm10-market-page', url: '/market', wait: 3000 },

    // === Settings page (with MobileProfileMenu) ===
    { name: 'm11-settings-page', url: '/settings', wait: 3000 },

    // === Search overlay ===
    { name: 'm12-search', url: '/', wait: 3000, action: async () => {
      // Click search button/icon in top nav
      const searchBtn = await page.$('[aria-label*="earch"], .search-trigger, button:has-text("Search")')
      if (searchBtn) {
        await searchBtn.click()
        await page.waitForTimeout(1500)
      }
    }},

    // === Login page ===
    { name: 'm13-login-page', url: '/login', wait: 2000 },

    // === Compare page ===
    { name: 'm14-compare-page', url: '/compare', wait: 2000 },

    // === Watchlist page ===
    { name: 'm15-watchlist-page', url: '/watchlist', wait: 2000 },
  ]

  const issues = []

  for (const s of screenshots) {
    try {
      console.log(`📸 ${s.name} (${s.url})`)
      await page.goto(`${BASE}${s.url}`, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForTimeout(s.wait || 2000)
      if (s.action) await s.action()

      // Check for common UI issues before screenshot
      const uiCheck = await page.evaluate(() => {
        const problems = []
        const vw = window.innerWidth

        // Check for horizontal overflow
        if (document.documentElement.scrollWidth > vw + 5) {
          problems.push(`Horizontal overflow: page is ${document.documentElement.scrollWidth}px wide, viewport is ${vw}px`)
        }

        // Check for elements overflowing viewport
        const allEls = document.querySelectorAll('*')
        const overflowing = []
        for (const el of allEls) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.right > vw + 10) {
            const tag = el.tagName.toLowerCase()
            const cls = el.className?.toString().slice(0, 50) || ''
            overflowing.push(`${tag}.${cls} overflows right by ${Math.round(rect.right - vw)}px`)
          }
        }
        if (overflowing.length > 0) {
          problems.push(`Elements overflowing viewport: ${overflowing.slice(0, 5).join('; ')}`)
        }

        // Check for overlapping fixed/sticky elements
        const fixedEls = []
        for (const el of allEls) {
          const style = window.getComputedStyle(el)
          if ((style.position === 'fixed' || style.position === 'sticky') && el.offsetHeight > 0) {
            const rect = el.getBoundingClientRect()
            fixedEls.push({
              tag: el.tagName.toLowerCase(),
              cls: el.className?.toString().slice(0, 40) || '',
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              height: Math.round(rect.height),
              zIndex: style.zIndex,
              position: style.position,
            })
          }
        }

        // Check if bottom nav overlaps content
        const bottomNav = fixedEls.filter(e => e.bottom >= window.innerHeight - 80 && e.position === 'fixed')
        const topFixed = fixedEls.filter(e => e.top <= 10 && e.position === 'fixed')
        if (bottomNav.length > 1) {
          problems.push(`Multiple fixed elements at bottom: ${bottomNav.map(e => `${e.tag}.${e.cls}`).join(', ')}`)
        }
        if (topFixed.length > 1) {
          problems.push(`Multiple fixed elements at top: ${topFixed.map(e => `${e.tag}.${e.cls}(z:${e.zIndex})`).join(', ')}`)
        }

        // Check for text truncation (elements with very small visible width but large content)
        const truncated = []
        for (const el of document.querySelectorAll('span, p, div, h1, h2, h3, a, button')) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0 && el.scrollWidth > rect.width + 20 && el.children.length === 0) {
            const text = el.textContent?.trim().slice(0, 30) || ''
            if (text.length > 5) {
              truncated.push(`"${text}..." (${Math.round(rect.width)}px visible, ${el.scrollWidth}px content)`)
            }
          }
        }
        if (truncated.length > 3) {
          problems.push(`Excessive text truncation (${truncated.length} elements): ${truncated.slice(0, 3).join('; ')}`)
        }

        // Check touch targets (buttons/links smaller than 36px)
        const smallTargets = []
        for (const el of document.querySelectorAll('button, a, [role="button"], input, select')) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0 && (rect.width < 30 || rect.height < 30)) {
            const label = (el.textContent?.trim().slice(0, 20) || el.getAttribute('aria-label') || el.tagName).slice(0, 25)
            smallTargets.push(`${label} (${Math.round(rect.width)}x${Math.round(rect.height)}px)`)
          }
        }
        if (smallTargets.length > 0) {
          problems.push(`Small touch targets (<30px): ${smallTargets.slice(0, 5).join('; ')}`)
        }

        return { problems, fixedEls }
      })

      if (uiCheck.problems.length > 0) {
        console.log(`  ⚠️  Issues found:`)
        uiCheck.problems.forEach(p => {
          console.log(`     - ${p}`)
          issues.push({ page: s.name, issue: p })
        })
      } else {
        console.log(`  ✅ No issues`)
      }

      await page.screenshot({
        path: path.join(OUT, `${s.name}.png`),
        fullPage: false,
      })
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`)
      issues.push({ page: s.name, issue: `Screenshot failed: ${err.message}` })
    }
  }

  // === Full-page screenshots for scroll content check ===
  console.log('\n📜 Full-page screenshots...')
  const fullPages = [
    { name: 'm-full-homepage', url: '/' },
    { name: 'm-full-settings', url: '/settings' },
  ]
  for (const s of fullPages) {
    try {
      console.log(`📸 ${s.name} (${s.url})`)
      await page.goto(`${BASE}${s.url}`, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForTimeout(3000)
      await page.screenshot({
        path: path.join(OUT, `${s.name}.png`),
        fullPage: true,
      })
      console.log(`  ✅ Saved`)
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`)
    }
  }

  await browser.close()

  // Summary
  console.log('\n' + '='.repeat(60))
  if (issues.length === 0) {
    console.log('✅ All mobile pages passed UI checks!')
  } else {
    console.log(`⚠️  ${issues.length} issues found across ${new Set(issues.map(i => i.page)).size} pages:\n`)
    for (const i of issues) {
      console.log(`  [${i.page}] ${i.issue}`)
    }
  }
  console.log('='.repeat(60))
  console.log(`\nScreenshots saved to: ${OUT}`)
}

main().catch(err => { console.error(err); process.exit(1) })

/* eslint-disable no-console */
import { chromium } from 'playwright'

const BASE = 'https://www.arenafi.org'
const VIEWPORT = { width: 430, height: 932 }
const DEVICE_SCALE = 3 // iPhone 14 Pro Max
const TRADER_SLUG = 'hyperliquid/0xedc3bcac96833616b45be1c5e7bbc3ca8b2fe60c'

const consoleErrors = []
const networkErrors = []
const http429Count = { count: 0 }

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function screenshot(page, name) {
  const path = `/tmp/arena-qa-${name}.png`
  await page.screenshot({ path, fullPage: false })
  console.log(`  [SCREENSHOT] ${path}`)
  return path
}

async function screenshotFull(page, name) {
  const path = `/tmp/arena-qa-${name}.png`
  await page.screenshot({ path, fullPage: true })
  console.log(`  [SCREENSHOT FULL] ${path}`)
  return path
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()

  // Track console errors and 429s
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text().substring(0, 200))
    }
  })
  page.on('response', (resp) => {
    if (resp.status() === 429) {
      http429Count.count++
    }
  })
  page.on('requestfailed', (req) => {
    networkErrors.push(`${req.url().substring(0, 100)} - ${req.failure()?.errorText}`)
  })

  // ═══════════════════════════════════════════════════════
  // TEST 1: /quiz landing page
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 1: Quiz Landing (/quiz) ===')
  try {
    await page.goto(`${BASE}/quiz`, { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(2000)
    await screenshot(page, '01-quiz-landing')

    // Check for Start Test button
    const _startBtn = await page.$('button, a, [role="button"]')
    const pageText = await page.textContent('body')
    const hasStartButton =
      pageText.toLowerCase().includes('start') ||
      pageText.toLowerCase().includes('begin') ||
      pageText.toLowerCase().includes('test')
    console.log(`  Start/Begin/Test button text found: ${hasStartButton}`)
    console.log(`  Page title area: ${pageText.substring(0, 300).replace(/\n/g, ' ')}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 2: Start Test - card-by-card flow
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 2: Start Test - Card Flow ===')
  try {
    // Find and click Start Test button
    const buttons = await page.$$('button, a[href*="quiz"]')
    let clicked = false
    for (const btn of buttons) {
      const text = await btn.textContent()
      if (text && (text.toLowerCase().includes('start') || text.toLowerCase().includes('begin'))) {
        await btn.click()
        clicked = true
        console.log(`  Clicked: "${text.trim()}"`)
        break
      }
    }
    if (!clicked) {
      // Try navigating directly to questions
      await page.goto(`${BASE}/quiz/questions`, { waitUntil: 'networkidle', timeout: 30000 })
      console.log('  Navigated directly to /quiz/questions')
    }
    await sleep(3000)
    await screenshot(page, '02-quiz-card-flow')

    // Check if card-by-card layout
    const bodyText = await page.textContent('body')
    const hasQ1 = bodyText.includes('1') || bodyText.includes('Q1') || bodyText.includes('Question')
    console.log(`  Card-by-card visible: question indicators present = ${hasQ1}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 3: Answer 3 questions - auto-advance
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 3: Answer 3 Questions ===')
  try {
    for (let q = 1; q <= 3; q++) {
      await sleep(1000)
      // Find answer options (buttons/radio/clickable elements within quiz area)
      const options = await page.$$('[data-option], [role="radio"], [role="button"], button')
      let answered = false
      for (const opt of options) {
        const text = await opt.textContent()
        const isVisible = await opt.isVisible()
        if (
          isVisible &&
          text &&
          text.length > 1 &&
          text.length < 200 &&
          !text.toLowerCase().includes('next') &&
          !text.toLowerCase().includes('back') &&
          !text.toLowerCase().includes('prev')
        ) {
          try {
            await opt.click()
            answered = true
            console.log(`  Q${q}: Clicked option "${text.trim().substring(0, 60)}"`)
            break
          } catch (_e) {
            continue
          }
        }
      }
      if (!answered) {
        // Try finding any clickable elements that look like answers
        const allClickable = await page.$$(
          'label, .option, [class*="option"], [class*="answer"], [class*="choice"]'
        )
        for (const el of allClickable) {
          const isVisible = await el.isVisible()
          if (isVisible) {
            try {
              await el.click()
              answered = true
              const text = await el.textContent()
              console.log(`  Q${q}: Clicked answer "${text?.trim().substring(0, 60)}"`)
              break
            } catch (_e) {
              continue
            }
          }
        }
      }
      if (!answered) {
        console.log(`  Q${q}: Could not find answer option to click`)
      }
      await sleep(1500) // Wait for auto-advance animation
    }
    await screenshot(page, '03-quiz-after-q3')

    const bodyText = await page.textContent('body')
    const currentQ =
      bodyText.match(/(\d+)\s*\/\s*\d+/) ||
      bodyText.match(/Q(\d+)/) ||
      bodyText.match(/question\s*(\d+)/i)
    console.log(`  Current question indicator: ${currentQ ? currentQ[0] : 'not found'}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 4: Navigate back to Q1 - answer preserved?
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 4: Navigate Back to Q1 ===')
  try {
    // Click back/prev buttons or dots to go back
    for (let i = 0; i < 3; i++) {
      const backBtns = await page.$$('button, [role="button"]')
      for (const btn of backBtns) {
        const text = await btn.textContent()
        const ariaLabel = await btn.getAttribute('aria-label')
        const isVisible = await btn.isVisible()
        if (
          isVisible &&
          ((text &&
            (text.toLowerCase().includes('back') ||
              text.toLowerCase().includes('prev') ||
              text.includes('<'))) ||
            (ariaLabel &&
              (ariaLabel.toLowerCase().includes('back') ||
                ariaLabel.toLowerCase().includes('prev'))))
        ) {
          try {
            await btn.click()
            console.log(`  Clicked back: "${(text || ariaLabel || '').trim().substring(0, 40)}"`)
            await sleep(1000)
            break
          } catch (_e) {
            continue
          }
        }
      }
    }

    // Try clicking dot 1 / first dot
    const dots = await page.$$(
      '[class*="dot"], [class*="progress"] button, [class*="indicator"] button, [data-index="0"]'
    )
    if (dots.length > 0) {
      try {
        await dots[0].click()
        console.log('  Clicked first dot/indicator')
        await sleep(1000)
      } catch (_e) {
        /* ignore */
      }
    }

    await screenshot(page, '04-quiz-back-to-q1')

    // Check for green check or selected state
    const html = await page.content()
    const hasCheck =
      html.includes('check') ||
      html.includes('selected') ||
      html.includes('answered') ||
      html.includes('completed') ||
      html.includes('#22c55e') ||
      html.includes('#10b981') ||
      html.includes('green')
    console.log(`  Green check/answered indicator found in HTML: ${hasCheck}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 5: Navigate to last question area
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 5: Navigate to Last Question ===')
  try {
    // Click Next repeatedly to reach the end
    for (let i = 0; i < 25; i++) {
      const nextBtns = await page.$$('button, [role="button"]')
      let clickedNext = false
      for (const btn of nextBtns) {
        const text = await btn.textContent()
        const ariaLabel = await btn.getAttribute('aria-label')
        const isVisible = await btn.isVisible()
        if (
          isVisible &&
          ((text && (text.toLowerCase().includes('next') || text.includes('>'))) ||
            (ariaLabel && ariaLabel.toLowerCase().includes('next')))
        ) {
          try {
            await btn.click()
            clickedNext = true
            break
          } catch (_e) {
            continue
          }
        }
      }
      if (!clickedNext) break
      await sleep(500)
    }
    await sleep(1000)
    await screenshot(page, '05-quiz-last-question')
    const bodyText = await page.textContent('body')
    const questionNum = bodyText.match(/(\d+)\s*\/\s*(\d+)/)
    console.log(`  Last question area: ${questionNum ? questionNum[0] : 'indicator not found'}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 6: Homepage
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 6: Homepage ===')
  try {
    const startTime = Date.now()
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30000 })
    const loadTime = Date.now() - startTime
    await sleep(2000)
    await screenshot(page, '06-homepage')
    await screenshotFull(page, '06-homepage-full')

    console.log(`  Load time: ${loadTime}ms`)

    const timing = await page.evaluate(() => {
      const perf = performance.getEntriesByType('navigation')[0]
      return {
        domContentLoaded: Math.round(perf?.domContentLoadedEventEnd || 0),
        load: Math.round(perf?.loadEventEnd || 0),
      }
    })
    console.log(`  DOMContentLoaded: ${timing.domContentLoaded}ms, Load: ${timing.load}ms`)

    // Check for horizontal overflow
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth
    })
    console.log(`  Horizontal overflow: ${hasHorizontalOverflow}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 7: Click trader -> detail page
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 7: Trader Detail Page ===')
  try {
    // Try clicking a trader from homepage first
    const traderLinks = await page.$$('a[href*="/trader/"]')
    if (traderLinks.length > 0) {
      await traderLinks[0].click()
      // eslint-disable-next-line no-restricted-syntax
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      await sleep(3000)
    } else {
      // Navigate directly
      await page.goto(`${BASE}/trader/${TRADER_SLUG}`, { waitUntil: 'networkidle', timeout: 30000 })
      await sleep(3000)
    }

    await screenshot(page, '07-trader-detail')
    await screenshotFull(page, '07-trader-detail-full')

    // Check what sections render
    const bodyText = await page.textContent('body')
    const sections = {
      ROI: bodyText.includes('ROI'),
      PnL: bodyText.includes('PnL') || bodyText.includes('P&L'),
      'Arena Score': bodyText.includes('Arena Score') || bodyText.includes('Score'),
      'Win Rate': bodyText.includes('Win Rate') || bodyText.includes('Win'),
      Chart: (await page.$('canvas, [class*="chart"], [class*="Chart"]')) !== null,
      'Period tabs':
        bodyText.includes('7D') || bodyText.includes('30D') || bodyText.includes('90D'),
    }
    for (const [name, present] of Object.entries(sections)) {
      console.log(`  ${present ? 'OK' : 'MISSING'}: ${name}`)
    }

    // Check horizontal overflow
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth
    })
    console.log(`  Horizontal overflow: ${hasOverflow}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 8: Period switch 90D -> 30D -> 7D
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 8: Period Switch ===')
  try {
    const periods = ['90D', '30D', '7D']
    for (const period of periods) {
      const buttons = await page.$$('button, [role="tab"], a')
      for (const btn of buttons) {
        const text = await btn.textContent()
        const isVisible = await btn.isVisible()
        if (isVisible && text && text.trim() === period) {
          await btn.click()
          console.log(`  Clicked period: ${period}`)
          await sleep(2000)
          await screenshot(page, `08-period-${period.toLowerCase()}`)
          break
        }
      }
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 9: Search "ETH"
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 9: Search "ETH" ===')
  try {
    await page.goto(`${BASE}/search?q=ETH`, { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)
    await screenshot(page, '09-search-eth')

    // Count result items
    const resultElements = await page.$$(
      '[class*="result"], [class*="trader"], [class*="row"], a[href*="/trader/"]'
    )
    console.log(`  Result elements found: ${resultElements.length}`)

    // Check for avatars
    const avatars = await page.$$('img[src*="avatar"], img[src*="dicebear"], img[class*="avatar"]')
    console.log(`  Avatar images found: ${avatars.length}`)

    // Check horizontal overflow
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth
    })
    console.log(`  Horizontal overflow: ${hasOverflow}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 10: /hot page
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 10: /hot (Posts) ===')
  try {
    await page.goto(`${BASE}/hot`, { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)
    await screenshot(page, '10-hot')

    const postLinks = await page.$$('a[href*="/post/"]')
    console.log(`  Post links found: ${postLinks.length}`)

    // Check for real titles (not empty)
    const headings = await page.$$eval('h2, h3, [class*="title"], [class*="post"]', (els) =>
      els
        .map((e) => e.textContent?.trim())
        .filter((t) => t && t.length > 5)
        .slice(0, 5)
    )
    console.log(`  Post titles (sample): ${JSON.stringify(headings.slice(0, 3))}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 11: /groups page
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 11: /groups ===')
  try {
    await page.goto(`${BASE}/groups`, { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(3000)
    await screenshot(page, '11-groups')

    const groupCards = await page.$$('a[href*="/groups/"], [class*="group"]')
    console.log(`  Group elements found: ${groupCards.length}`)
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // TEST 12-14: Technical checks
  // ═══════════════════════════════════════════════════════
  console.log('\n=== TEST 12: Console 429 count ===')
  console.log(`  Total 429 responses: ${http429Count.count}`)

  console.log('\n=== TEST 13: Horizontal Overflow (Final Check) ===')
  // Navigate through key pages for final overflow check
  for (const path of ['/', '/quiz', '/groups']) {
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 15000 })
      await sleep(1000)
      const overflow = await page.evaluate(() => {
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        }
      })
      console.log(
        `  ${path}: scrollWidth=${overflow.scrollWidth}, clientWidth=${overflow.clientWidth}, overflow=${overflow.hasOverflow}`
      )
    } catch (e) {
      console.log(`  ${path}: ERROR - ${e.message.substring(0, 100)}`)
    }
  }

  console.log('\n=== TEST 14: Cookie Banner ===')
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 15000 })
    await sleep(2000)
    const cookieBanner = await page.$(
      '[class*="cookie"], [class*="consent"], [id*="cookie"], [id*="consent"]'
    )
    if (cookieBanner) {
      const box = await cookieBanner.boundingBox()
      console.log(`  Cookie banner found: height=${box?.height}px`)
      console.log(`  Slim? ${(box?.height || 0) < 120 ? 'YES' : 'NO - too tall'}`)
    } else {
      console.log('  No cookie banner found')
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`)
  }

  // ═══════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════
  console.log('\n\n========== SUMMARY ==========')
  console.log(`Console errors total: ${consoleErrors.length}`)
  if (consoleErrors.length > 0) {
    console.log('Sample console errors:')
    consoleErrors.slice(0, 5).forEach((e) => console.log(`  - ${e}`))
  }
  console.log(`Network failures: ${networkErrors.length}`)
  if (networkErrors.length > 0) {
    networkErrors.slice(0, 5).forEach((e) => console.log(`  - ${e}`))
  }
  console.log(`HTTP 429 responses: ${http429Count.count}`)

  await browser.close()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})

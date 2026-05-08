/* eslint-disable no-console */
import { chromium } from 'playwright'

const BASE = 'https://www.arenafi.org'
const VIEWPORT = { width: 430, height: 932 }

async function clickFirstOption(page) {
  // Try text matching for common option A texts
  const optTexts = [
    'Smash that buy button',
    'Pull up my charts',
    'Check the news',
    'Go all-in',
    'Buy more',
    'Sell everything',
    'Diamond hands',
    'HODL',
  ]
  for (const t of optTexts) {
    const el = await page.$(`text=${t}`)
    if (el) {
      const isVisible = await el.isVisible()
      if (isVisible) {
        await el.click()
        return `text: "${t.substring(0, 40)}"`
      }
    }
  }
  // Fallback: find option cards with A/B/C/D
  const cards = await page.$$('[class*="option"], [class*="card"]')
  for (const card of cards) {
    const text = await card.textContent().catch(() => '')
    const isVisible = await card.isVisible().catch(() => false)
    const box = await card.boundingBox().catch(() => null)
    if (isVisible && text && text.trim().length > 5 && box && box.height > 30 && box.width > 150) {
      if (
        !text.includes('/') &&
        !text.includes('Next') &&
        !text.includes('Back') &&
        text.length < 200
      ) {
        await card.click()
        return `card: "${text.trim().substring(0, 40)}"`
      }
    }
  }
  // Ultimate fallback: click at option A position (center-x, y=380)
  await page.mouse.click(215, 380)
  return 'mouse click at (215, 380)'
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 3,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()

  await page.goto(`${BASE}/quiz`, { waitUntil: 'networkidle', timeout: 30000 })
  await new Promise((r) => setTimeout(r, 2000))

  // Click Start Test
  const startBtn = await page.$('text=Start Test')
  if (startBtn) await startBtn.click()
  await new Promise((r) => setTimeout(r, 3000))

  // Answer Q1
  console.log('=== Q1 ===')
  let result = await clickFirstOption(page)
  console.log(`  Clicked: ${result}`)
  await new Promise((r) => setTimeout(r, 2000))

  let bodyText = await page.textContent('body')
  let indicator = bodyText.match(/(\d+)\s*\/\s*30/)
  console.log(`  After answer indicator: ${indicator ? indicator[0] : 'N/A'}`)
  console.log(`  Auto-advanced to Q2: ${indicator && indicator[1] === '2'}`)
  await page.screenshot({ path: '/tmp/arena-qa-quiz-q2.png', fullPage: false })

  // Answer Q2
  console.log('\n=== Q2 ===')
  result = await clickFirstOption(page)
  console.log(`  Clicked: ${result}`)
  await new Promise((r) => setTimeout(r, 2000))

  bodyText = await page.textContent('body')
  indicator = bodyText.match(/(\d+)\s*\/\s*30/)
  console.log(`  After answer indicator: ${indicator ? indicator[0] : 'N/A'}`)
  console.log(`  Auto-advanced to Q3: ${indicator && indicator[1] === '3'}`)

  // Answer Q3
  console.log('\n=== Q3 ===')
  result = await clickFirstOption(page)
  console.log(`  Clicked: ${result}`)
  await new Promise((r) => setTimeout(r, 2000))

  bodyText = await page.textContent('body')
  indicator = bodyText.match(/(\d+)\s*\/\s*30/)
  console.log(`  After answer indicator: ${indicator ? indicator[0] : 'N/A'}`)
  console.log(`  Auto-advanced to Q4: ${indicator && indicator[1] === '4'}`)
  await page.screenshot({ path: '/tmp/arena-qa-quiz-after-q3-proper.png', fullPage: false })

  // Navigate back to Q1
  console.log('\n=== Navigate Back to Q1 ===')
  // Look for any back navigation
  let backClickCount = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    const btns = await page.$$('button, [role="button"]')
    for (const btn of btns) {
      const text = (await btn.textContent().catch(() => '')).trim()
      const ariaLabel = (await btn.getAttribute('aria-label').catch(() => '')) || ''
      const isVisible = await btn.isVisible().catch(() => false)
      if (
        isVisible &&
        (text === 'Back' ||
          text === 'Prev' ||
          text === '<' ||
          ariaLabel.toLowerCase().includes('back') ||
          ariaLabel.toLowerCase().includes('prev') ||
          ariaLabel.toLowerCase().includes('previous'))
      ) {
        await btn.click()
        backClickCount++
        console.log(`  Clicked back (${backClickCount}): "${text || ariaLabel}"`)
        await new Promise((r) => setTimeout(r, 800))
        break
      }
    }
  }

  if (backClickCount === 0) {
    // Try looking for dot/progress navigation
    console.log('  No explicit back button found, trying progress dots...')
    const progressDots = await page.$$('[class*="dot"], [class*="step"], [class*="indicator"] > *')
    if (progressDots.length > 0) {
      await progressDots[0].click()
      console.log(`  Clicked first progress dot (of ${progressDots.length})`)
    }
  }

  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: '/tmp/arena-qa-quiz-back-q1-proper.png', fullPage: false })

  bodyText = await page.textContent('body')
  indicator = bodyText.match(/(\d+)\s*\/\s*30/)
  console.log(`  Current indicator: ${indicator ? indicator[0] : 'N/A'}`)

  // Check for green/selected state
  const html = await page.content()
  const greenIndicators = [
    html.includes('#22c55e'),
    html.includes('#10b981'),
    html.includes('bg-green'),
    html.includes('border-green'),
    html.includes('text-green'),
    html.includes('emerald'),
    html.includes('selected'),
    html.includes('answered'),
    html.includes('check'),
  ]
  const anyGreen = greenIndicators.some((v) => v)
  console.log(`  Answer preserved indicator: ${anyGreen}`)
  console.log(
    `  Specific: green-color=${greenIndicators[0] || greenIndicators[1]}, bg-green=${greenIndicators[2]}, selected=${greenIndicators[5]}, answered=${greenIndicators[6]}, check=${greenIndicators[7]}`
  )

  // Navigate to last question area
  console.log('\n=== Navigate to Last Question ===')
  let navCount = 0
  for (let i = 0; i < 30; i++) {
    const btns = await page.$$('button, [role="button"]')
    let clicked = false
    for (const btn of btns) {
      const text = (await btn.textContent().catch(() => '')).trim()
      const ariaLabel = (await btn.getAttribute('aria-label').catch(() => '')) || ''
      const isVisible = await btn.isVisible().catch(() => false)
      if (
        isVisible &&
        (text === 'Next' ||
          text.includes('Next') ||
          ariaLabel.toLowerCase().includes('next') ||
          text === '>')
      ) {
        await btn.click()
        clicked = true
        navCount++
        break
      }
    }
    if (!clicked) {
      console.log(`  Could not find Next at iteration ${i + 1}`)
      break
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`  Navigated ${navCount} times`)
  await new Promise((r) => setTimeout(r, 1000))
  await page.screenshot({ path: '/tmp/arena-qa-quiz-last-area.png', fullPage: false })

  bodyText = await page.textContent('body')
  indicator = bodyText.match(/(\d+)\s*\/\s*30/)
  console.log(`  Final indicator: ${indicator ? indicator[0] : 'N/A'}`)

  await browser.close()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})

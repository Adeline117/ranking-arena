---
name: arena-browse
description: Headless browser for QA — navigate URLs, click elements, take screenshots, test forms, check responsive layouts.
---

# Arena Browse

> **Shared patterns**: Read `.claude/skills/arena-shared-preamble.md` for Boil the Lake philosophy.

Fast headless browser for QA testing Arena pages. Navigate, interact, screenshot, and verify.

## Setup

Requires Playwright installed:
```bash
npx playwright install chromium 2>/dev/null || echo "Playwright already installed"
```

## Commands

### Navigate to URL
```bash
# Take a screenshot of any Arena page
npx playwright screenshot --browser chromium "http://localhost:3000" /tmp/arena-screenshot.png

# With specific viewport (mobile)
npx playwright screenshot --browser chromium --viewport-size "375,812" "http://localhost:3000" /tmp/arena-mobile.png

# With specific viewport (tablet)
npx playwright screenshot --browser chromium --viewport-size "768,1024" "http://localhost:3000" /tmp/arena-tablet.png
```

### Programmatic Browser Script
For complex interactions, create and run inline Playwright scripts:

```javascript
// arena-browse-test.mjs
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

// Navigate
await page.goto('http://localhost:3000')

// Wait for content
await page.waitForSelector('[data-testid="trader-row"]', { timeout: 10000 })

// Screenshot
await page.screenshot({ path: '/tmp/arena-home.png', fullPage: true })

// Click and interact
await page.click('[data-testid="period-30d"]')
await page.waitForTimeout(1000)
await page.screenshot({ path: '/tmp/arena-30d.png', fullPage: true })

// Check element state
const traderCount = await page.$$eval('[data-testid="trader-row"]', els => els.length)
console.log(`Trader rows visible: ${traderCount}`)

// Check for console errors
page.on('console', msg => {
  if (msg.type() === 'error') console.log(`Console error: ${msg.text()}`)
})

// Check for network errors
page.on('requestfailed', req => {
  console.log(`Failed request: ${req.url()} — ${req.failure()?.errorText}`)
})

await browser.close()
```

Run with:
```bash
node arena-browse-test.mjs
```

## QA Testing Patterns

### 1. Core Path Screenshots
```bash
# Capture all core path pages
for path in "/" "/rankings" "/trader/some-id" "/search?q=test"; do
  npx playwright screenshot --browser chromium "http://localhost:3000${path}" "/tmp/arena${path//\//-}.png"
done
```

### 2. Responsive Layout Check
Test 4 breakpoints for any page:
```javascript
const viewports = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1920, height: 1080 },
]
for (const vp of viewports) {
  await page.setViewportSize({ width: vp.width, height: vp.height })
  await page.screenshot({ path: `/tmp/arena-${vp.name}.png`, fullPage: true })
}
```

### 3. Form Testing
```javascript
// Search form
await page.fill('[data-testid="search-input"]', 'test trader')
await page.press('[data-testid="search-input"]', 'Enter')
await page.waitForTimeout(2000)
const results = await page.$$eval('[data-testid="search-result"]', els => els.length)
console.log(`Search results: ${results}`)
```

### 4. Auth Flow Testing
```javascript
// Login flow (if testing auth)
await page.goto('http://localhost:3000/login')
await page.screenshot({ path: '/tmp/arena-login.png' })
// Check for auth buttons
const authButtons = await page.$$('button[data-testid*="auth"]')
console.log(`Auth buttons found: ${authButtons.length}`)
```

### 5. Performance Timing
```javascript
const timing = await page.evaluate(() => {
  const perf = performance.getEntriesByType('navigation')[0]
  return {
    domContentLoaded: Math.round(perf.domContentLoadedEventEnd),
    load: Math.round(perf.loadEventEnd),
    firstPaint: Math.round(performance.getEntriesByName('first-paint')[0]?.startTime || 0),
  }
})
console.log('Performance:', timing)
```

### 6. Accessibility Check
```javascript
// Check for missing alt text
const imagesNoAlt = await page.$$eval('img:not([alt])', els => els.map(e => e.src))
if (imagesNoAlt.length) console.log('Images without alt:', imagesNoAlt)

// Check for missing labels
const inputsNoLabel = await page.$$eval('input:not([aria-label]):not([id])', els => els.length)
if (inputsNoLabel) console.log(`Inputs without labels: ${inputsNoLabel}`)
```

## Integration with /qa

The `/qa` and `/qa-report` commands can use `/browse` for visual verification:
1. Navigate to page
2. Screenshot before fix
3. Apply fix
4. Screenshot after fix
5. Compare visually

## Output

Screenshots saved to `/tmp/arena-*.png`. Read them with the Read tool to view visually.

## Arena-Specific Pages to Test

| Page | URL | Key Elements |
|------|-----|--------------|
| Homepage | `/` | Hero stats, top traders, exchange logos |
| Rankings | `/rankings` | Table, filters, pagination, period switch |
| Trader Detail | `/trader/[id]` | Profile, stats, chart, score breakdown |
| Search | `/search?q=` | Results, relevance, empty state |
| Exchange | `/exchange/[id]` | Exchange-specific rankings |
| Groups | `/groups` | Group list, member count |
| Library | `/library` | Resource grid, categories |
| Pro | `/pro` | Pricing, feature comparison |
| Login | `/login` | Auth buttons, social login |
| Admin | `/admin` | Dashboard (requires auth) |

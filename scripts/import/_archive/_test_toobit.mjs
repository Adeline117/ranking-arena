import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

// Collect API data
const apiData = []
page.on('request', (req) => {
  const url = req.url()
  if (url.includes('copy') || url.includes('leader')) {
    console.log('REQ:', url.substring(0, 150))
  }
})

await page.goto('https://www.toobit.com/en-US/copy-trading', { timeout: 30000, waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 10000))

// Scroll
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => window.scrollBy(0, 800))
  await new Promise(r => setTimeout(r, 2000))
}

// Get page content
const text = await page.evaluate(() => document.body.innerText.substring(0, 3000))
console.log('\n=== PAGE TEXT ===')
console.log(text.substring(0, 2000))

// Check for trader cards / elements
const info = await page.evaluate(() => {
  const all = document.querySelectorAll('*')
  const classes = new Set()
  for (const el of all) {
    for (const c of el.classList) {
      if (c.toLowerCase().includes('trader') || c.toLowerCase().includes('leader') || c.toLowerCase().includes('card') || c.toLowerCase().includes('copy')) {
        classes.add(c + ':' + document.querySelectorAll('.' + CSS.escape(c)).length)
      }
    }
  }
  return [...classes].slice(0, 30)
})
console.log('\n=== RELEVANT CLASSES ===')
console.log(info)

await browser.close()

#!/usr/bin/env node
/**
 * Debug: Check if BingX API returns UIDs as numbers or strings
 * Also check the raw pagination approach
 */
import { chromium } from 'playwright'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await ctx.newPage()

  let rawTexts = []
  let allUids = []

  // Intercept RAW text of all recommend responses
  page.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('recommend') && !url.includes('rank')) return
    if (resp.status() >= 400) return
    try {
      const text = await resp.text()
      if (!text.startsWith('{')) return
      
      // Extract UIDs from raw text BEFORE JSON.parse (preserves precision)
      const uidMatches = text.match(/"uid"\s*:\s*"?(\d{10,20})"?/g) || []
      const uidsFromText = uidMatches.map(m => m.match(/(\d{10,20})/)[1])
      
      // Also parse JSON (may lose precision for large UIDs)
      let jsonUids = []
      try {
        const json = JSON.parse(text)
        const items = json?.data?.result || json?.data?.list || []
        jsonUids = items.map(i => String(i.trader?.uid || i.uid || '')).filter(u => u && u !== '0')
      } catch {}
      
      // Compare
      const shortUrl = url.split('/').slice(-3).join('/').replace(/\?.*$/, '')
      console.log(`\n${shortUrl}:`)
      console.log(`  UIDs from raw text: ${uidsFromText.length}`)
      console.log(`  UIDs from JSON.parse: ${jsonUids.length}`)
      
      // Check for mismatches
      for (let i = 0; i < Math.min(uidsFromText.length, jsonUids.length); i++) {
        if (uidsFromText[i] !== jsonUids[i]) {
          console.log(`  MISMATCH [${i}]: raw="${uidsFromText[i]}" json="${jsonUids[i]}"`)
        }
      }
      
      // Check if UIDs are strings or numbers in JSON
      if (uidMatches.length > 0) {
        const firstMatch = uidMatches[0]
        const isString = firstMatch.includes('"uid":"') || firstMatch.includes('"uid" : "') 
        console.log(`  UID format in JSON: ${isString ? 'STRING' : 'NUMBER'}`)
        console.log(`  Sample raw match: ${uidMatches[0]}`)
      }
      
      rawTexts.push(text)
      allUids.push(...uidsFromText)
    } catch (e) {}
  })

  await page.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => {})
  await sleep(4000)

  // Try clicking through pagination
  console.log('\n\nPaginating via UI clicks...')
  let capturedPages = 0
  
  for (let attempt = 0; attempt < 20; attempt++) {
    const prevCount = allUids.length
    
    // Try different pagination approaches
    let clicked = false
    
    // Strategy 1: Click numbered page cells
    try {
      const cells = await page.locator('.page-cell').all()
      if (cells.length > 0) {
        // Find active cell
        let activeIdx = -1
        for (let i = 0; i < cells.length; i++) {
          const isActive = await cells[i].evaluate(el => el.classList.contains('active')).catch(() => false)
          if (isActive) { activeIdx = i; break }
        }
        // Click next cell after active
        if (activeIdx >= 0 && activeIdx + 1 < cells.length) {
          const nextCell = cells[activeIdx + 1]
          const txt = (await nextCell.textContent().catch(() => '')).trim()
          if (txt && !txt.includes('...') && txt !== '>') {
            await nextCell.click()
            clicked = true
            console.log(`  Clicked page cell "${txt}"`)
          }
        }
        
        // If no active found, click last non-disabled cell (next arrow)
        if (!clicked && cells.length > 0) {
          const last = cells[cells.length - 1]
          const txt = (await last.textContent().catch(() => '')).trim()
          await last.click()
          clicked = true
          console.log(`  Clicked last cell "${txt}"`)
        }
      }
    } catch (e) {
      console.log(`  Cell click error: ${e.message.slice(0, 60)}`)
    }
    
    // Strategy 2: Click > or → arrow
    if (!clicked) {
      try {
        const arrows = [
          page.locator('li.next:not(.disabled)'),
          page.locator('[class*="next-btn"]:not([disabled])'),
          page.locator('button[aria-label*="Next"]'),
          page.locator('.pagination-next:not(.disabled)'),
        ]
        for (const arrow of arrows) {
          if (await arrow.isVisible({ timeout: 500 }).catch(() => false)) {
            await arrow.click()
            clicked = true
            console.log('  Clicked next arrow')
            break
          }
        }
      } catch {}
    }
    
    await sleep(1500)
    
    const newCount = allUids.length
    const diff = newCount - prevCount
    console.log(`  Attempt ${attempt + 1}: ${clicked ? 'clicked' : 'not clicked'}, +${diff} UIDs (total=${newCount})`)
    
    if (!clicked && attempt > 1) break
    if (diff === 0 && attempt > 2) break
    
    capturedPages++
  }

  // Now check: what UIDs are in DB vs what we captured
  console.log('\n\nAll unique UIDs captured from API:')
  const uniqueUids = [...new Set(allUids)]
  console.log(`Total: ${uniqueUids.length}`)
  console.log('Sample:', uniqueUids.slice(0, 5))
  
  // Check target UIDs
  const TARGET_UIDS = [
    '1339191395874545700', '1378910400354312200', '1469964778594295800',
    '856009244589367300', '1532885692632047623', '1008921387662278659',
    '1998800000085953', '1518262070860882000', '1373505428236574700',
  ]
  
  console.log('\nTarget UID matching:')
  for (const tuid of TARGET_UIDS) {
    const exactMatch = uniqueUids.includes(tuid)
    // Also check if any UID is "close" (within rounding error)
    const tidN = Number(tuid)
    const fuzzyMatch = uniqueUids.find(u => Math.abs(Number(u) - tidN) < 1000)
    
    if (exactMatch) {
      console.log(`  ✅ ${tuid}: EXACT match`)
    } else if (fuzzyMatch) {
      console.log(`  ⚠️  ${tuid}: FUZZY match with ${fuzzyMatch} (diff=${Number(fuzzyMatch) - tidN})`)
    } else {
      console.log(`  ❌ ${tuid}: NOT FOUND`)
    }
  }

  await browser.close()
  console.log('\nDone')
}

main().catch(e => { console.error(e); process.exit(1) })

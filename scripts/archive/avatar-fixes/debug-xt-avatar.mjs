#!/usr/bin/env node
/**
 * Debug: check what avatar fields XT.com API actually returns
 */
import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('symbol') || (!url.includes('leader') && !url.includes('elite') && !url.includes('trader'))) return
    
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      console.log('\n=== API URL:', url.substring(0, 120))

      // Find trader items
      let items = []
      if (Array.isArray(json?.result)) {
        for (const cat of json.result) {
          if (cat.items?.length) items.push(...cat.items)
        }
      } else if (json?.result?.items) {
        items = json.result.items
      } else if (json?.data?.list) {
        items = json.data.list
      }

      if (items.length > 0) {
        console.log('  Item count:', items.length)
        console.log('  ALL fields:', Object.keys(items[0]).join(', '))
        
        // Check for avatar-like fields
        const first = items[0]
        const avatarFields = Object.keys(first).filter(k => 
          k.toLowerCase().includes('avatar') || 
          k.toLowerCase().includes('photo') || 
          k.toLowerCase().includes('image') || 
          k.toLowerCase().includes('img') ||
          k.toLowerCase().includes('head') ||
          k.toLowerCase().includes('icon') ||
          k.toLowerCase().includes('pic')
        )
        console.log('  Avatar-like fields:', avatarFields.length ? avatarFields.join(', ') : 'NONE')
        
        // Show values for avatar fields
        for (const field of avatarFields) {
          const vals = items.slice(0, 5).map(i => i[field])
          console.log(`    ${field}:`, vals)
        }
        
        // Show first trader sample
        console.log('  Sample trader:', JSON.stringify(items[0]).substring(0, 500))
      }
    } catch {}
  })

  console.log('Navigating to XT copy trading...')
  await page.goto('https://www.xt.com/en/copy-trading/futures', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  
  // Close popups
  for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I am not', 'Start']) {
    const btn = page.getByRole('button', { name: text })
    if (await btn.count() > 0) await btn.first().click().catch(() => {})
  }
  
  await new Promise(r => setTimeout(r, 5000))
  console.log('\nDone. Closing...')
  await browser.close()
}

main().catch(console.error)

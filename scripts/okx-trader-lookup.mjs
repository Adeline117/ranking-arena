import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Get a sample okx_web3 trader with known WR to find the API
const { data } = await sb.from('trader_snapshots').select('source_trader_id').eq('source', 'okx_web3').not('win_rate', 'is', null).limit(1)
const sampleId = data?.[0]?.source_trader_id
console.log('Testing with ID:', sampleId)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' })
const page = await ctx.newPage()

page.on('response', async res => {
  const url = res.url()
  if (url.includes('priapi') && !url.includes('.js') && !url.includes('.png')) {
    try {
      const ct = res.headers()['content-type'] || ''
      if (ct.includes('json')) {
        const body = await res.json()
        const str = JSON.stringify(body)
        if (str.includes('winRate') || str.includes('pnlHistory') || str.includes('roi')) {
          console.log(`\n✅ API with data: ${url.slice(0, 200)}`)
          console.log(str.slice(0, 800))
        }
      }
    } catch {}
  }
})

// Try the trader profile page
const addr = sampleId?.replace('...', '0000').slice(0, 42)  // just use some placeholder
await page.goto(`https://web3.okx.com/zh-hans/strategy-center/copy-trading-signals/trader/${sampleId}`, { timeout: 30000 })
await page.waitForTimeout(5000)
await browser.close()

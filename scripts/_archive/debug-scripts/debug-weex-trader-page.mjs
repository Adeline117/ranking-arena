#!/usr/bin/env node
/**
 * Navigate to individual trader profile pages and intercept API calls to find avatar
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const PROXY = 'http://127.0.0.1:7890'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { data: nullRows } = await sb.from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'weex')
    .is('avatar_url', null)
    .limit(10)

  const testId = nullRows[0].source_trader_id
  console.log(`Testing trader: ${testId} (${nullRows[0].handle})`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  const apiCalls = []
  context.on('request', req => {
    const url = req.url()
    if (url.includes('/api/') && req.method() === 'POST') {
      apiCalls.push({ url, body: req.postData() })
    }
  })

  context.on('response', async resp => {
    const url = resp.url()
    if (url.includes('/api/') && url.includes('trace')) {
      try {
        const text = await resp.text().catch(() => '')
        if (text.includes('headPic') || text.includes('avatar') || text.includes('portrait')) {
          const json = JSON.parse(text)
          console.log('\n📡 API response with avatar fields:', url.split('/api/')[1])
          if (json.data) {
            const findAvatarFields = (obj, prefix='') => {
              for (const [k, v] of Object.entries(obj)) {
                if (/head|avatar|photo|portrait|pic|img|icon/i.test(k)) {
                  console.log(`  ${prefix}${k}:`, typeof v === 'string' ? v.slice(0, 100) : v)
                }
                if (v && typeof v === 'object' && !Array.isArray(v)) findAvatarFields(v, prefix + k + '.')
              }
            }
            findAvatarFields(json.data)
          }
        }
      } catch {}
    }
  })

  const page = await context.newPage()

  // Try different URL patterns for trader profile
  const urlPatterns = [
    `https://www.weex.com/copy-trading/trader/${testId}`,
    `https://www.weex.com/copy-trading/detail/${testId}`,
    `https://www.weex.com/en/copy-trading/trader/${testId}`,
    `https://www.weex.com/copy-trading#trader=${testId}`,
  ]

  for (const url of urlPatterns) {
    console.log(`\n--- Trying: ${url} ---`)
    apiCalls.length = 0
    try {
      await page.goto(url, { timeout: 30000, waitUntil: 'networkidle' })
      await sleep(3000)
      console.log(`Page title: ${await page.title()}`)
      console.log(`URL after nav: ${page.url()}`)
      console.log(`API calls: ${apiCalls.map(c => c.url.split('/api/')[1]?.split('?')[0]).join(', ')}`)
    } catch(e) {
      console.log('Error:', e.message.slice(0, 80))
    }
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })

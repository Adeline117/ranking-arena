#!/usr/bin/env node
/**
 * Intercept ALL API calls on a null-avatar trader's profile page
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
    .limit(3)

  const testId = nullRows[0].source_trader_id
  console.log(`Testing trader: ${testId} (${nullRows[0].handle})`)

  // Also pick a trader we know HAS an avatar (check from API)
  const { data: withAvatar } = await sb.from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', 'weex')
    .not('avatar_url', 'is', null)
    .limit(1)
  const withId = withAvatar?.[0]?.source_trader_id
  console.log(`With-avatar trader: ${withId} (${withAvatar?.[0]?.handle}) avatar: ${withAvatar?.[0]?.avatar_url?.slice(0,60)}`)

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })

  const client = await context.newCDPSession(await context.newPage())
  
  const browser2 = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx2 = await browser2.newContext({
    proxy: { server: PROXY },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  
  const apiResponses = []
  ctx2.on('response', async resp => {
    const url = resp.url()
    if (url.includes('weex') || url.includes('janapw') || url.includes('wexx')) {
      if (!url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.svg')) {
        try {
          const text = await resp.text().catch(() => '')
          if (text.includes('{') && text.length < 100000) {
            apiResponses.push({ url: url.split('?')[0], status: resp.status(), body: text })
          }
        } catch {}
      }
    }
  })

  const page2 = await ctx2.newPage()
  console.log(`\n--- Loading null-avatar trader page: ${testId} ---`)
  try {
    await page2.goto(`https://www.weex.com/copy-trading/trader/${testId}`, { timeout: 30000, waitUntil: 'networkidle' })
    await sleep(3000)
  } catch(e) { console.log('Nav error:', e.message.slice(0,80)) }

  console.log(`API responses captured: ${apiResponses.length}`)
  for (const r of apiResponses) {
    console.log(`\n  [${r.status}] ${r.url.slice(0, 100)}`)
    if (r.body.length > 10) {
      try {
        const json = JSON.parse(r.body)
        if (json.data || json.code) {
          console.log('  code:', json.code)
          // Find any avatar/pic fields
          const bodyStr = JSON.stringify(json.data || json)
          const matches = bodyStr.match(/"(head|avatar|photo|portrait|pic|img)[A-Za-z]*":"([^"]{5,200})"/gi)
          if (matches) console.log('  Avatar fields:', matches.slice(0,5).join('\n    '))
          else console.log('  No avatar fields. Keys:', Object.keys(json.data || json).slice(0,10).join(', '))
        }
      } catch { console.log('  (non-JSON)') }
    }
  }

  // Also check all image URLs on page
  const imgs = await page2.evaluate(() => {
    return [...document.querySelectorAll('img')].map(i => i.src).filter(s => s && !s.includes('data:'))
  })
  const avatarLikeImgs = imgs.filter(s => s.includes('trace') || s.includes('wexx.one') || s.includes('cloudfront'))
  console.log('\nAvatar-like images on page:', avatarLikeImgs.length ? avatarLikeImgs : 'none')

  // Now compare with a trader that HAS an avatar
  if (withId) {
    apiResponses.length = 0
    console.log(`\n--- Loading WITH-avatar trader page: ${withId} ---`)
    try {
      await page2.goto(`https://www.weex.com/copy-trading/trader/${withId}`, { timeout: 30000, waitUntil: 'networkidle' })
      await sleep(3000)
    } catch(e) { console.log('Nav error:', e.message.slice(0,80)) }
    
    const imgs2 = await page2.evaluate(() => {
      return [...document.querySelectorAll('img')].map(i => i.src).filter(s => s && !s.includes('data:'))
    })
    const avatarLike2 = imgs2.filter(s => s.includes('trace') || s.includes('wexx.one') || s.includes('cloudfront'))
    console.log('Avatar-like images:', avatarLike2.length ? avatarLike2 : 'none')
    console.log('API responses:', apiResponses.length)
    for (const r of apiResponses) {
      console.log(`  [${r.status}] ${r.url.slice(0, 100)}`)
    }
  }

  await browser2.close()
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })

#!/usr/bin/env node
/**
 * fetch-xt-avatars.mjs — Fetch XT.com trader avatars via direct API + Playwright fallback
 *
 * XT's elite-leader-list-v2 only returns ~15 unique traders.
 * To get all 500, we need to use the search/filter API via Playwright cookie.
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log('🔄 XT.com Avatar Fetch\n')

  // Get all XT traders needing avatars
  let traders = []
  let from = 0
  while (true) {
    const { data } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', 'xt')
      .is('avatar_url', null)
      .range(from, from + 999)
    if (!data?.length) break
    traders = traders.concat(data)
    from += 1000
    if (data.length < 1000) break
  }
  console.log(`XT traders needing avatar: ${traders.length}`)
  if (!traders.length) return

  // Create a set of IDs we need
  const needIds = new Set(traders.map(t => t.source_trader_id))

  // Launch browser to get cookies, then use API
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  const avatarMap = new Map()

  // Intercept all API responses
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy-trade') && !url.includes('leader') && !url.includes('trader')) return
    if (url.includes('.js') || url.includes('.css') || url.includes('symbol')) return

    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      let items = []
      if (Array.isArray(json?.result)) {
        for (const cat of json.result) {
          if (cat.items?.length) items.push(...cat.items)
        }
      }
      if (json?.result?.items) items = json.result.items
      if (json?.result?.records) items = json.result.records
      if (json?.data?.list) items.push(...json.data.list)

      for (const t of items) {
        const id = String(t.accountId || t.uid || t.traderId || '')
        const avatar = t.avatar || t.avatarUrl || null
        if (id && avatar) {
          avatarMap.set(id, avatar)
        }
      }
    } catch {}
  })

  // Navigate
  console.log('Navigating to XT copy trading...')
  await page.goto('https://www.xt.com/en/copy-trading/futures', {
    waitUntil: 'networkidle', timeout: 60000
  }).catch(() => console.log('  ⚠ Navigation timeout'))

  // Close popups
  for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I am not', 'Start']) {
    const btn = page.getByRole('button', { name: text })
    if (await btn.count() > 0) await btn.first().click().catch(() => {})
  }
  await sleep(3000)
  console.log(`After initial load: ${avatarMap.size} avatars`)

  // Try to find a "View All" or list page
  const viewAllLinks = page.locator('a[href*="all"], a[href*="list"], a[href*="rank"]')
  const linkCount = await viewAllLinks.count()
  if (linkCount > 0) {
    for (let i = 0; i < linkCount; i++) {
      const href = await viewAllLinks.nth(i).getAttribute('href').catch(() => '')
      console.log(`  Found link: ${href}`)
    }
    await viewAllLinks.first().click().catch(() => {})
    await sleep(5000)
    console.log(`After view all: ${avatarMap.size} avatars`)
  }

  // Try different sort/filter tabs to get more traders
  const sortOptions = ['ROI', 'PnL', 'Profit', 'Followers', 'Win Rate', 'Copiers']
  for (const sort of sortOptions) {
    const el = page.getByText(sort, { exact: true })
    if (await el.count() > 0) {
      await el.first().click().catch(() => {})
      await sleep(3000)
      console.log(`  After ${sort}: ${avatarMap.size} avatars`)
    }
  }

  // Try different period tabs
  for (const period of ['7 Days', '30 Days', '90 Days']) {
    const el = page.getByText(period, { exact: true })
    if (await el.count() > 0) {
      await el.first().click().catch(() => {})
      await sleep(3000)

      // Scroll within each period
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1500)
        
        // Click "Load More" if exists
        const more = page.getByText(/Load More|Show More|更多|加载更多/i)
        if (await more.count() > 0) await more.first().click().catch(() => {})
      }
      console.log(`  After ${period} + scroll: ${avatarMap.size} avatars`)
    }
  }

  // Get cookies and try direct API calls with pagination
  const cookies = await context.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  // Try paginated API endpoints
  for (let page_num = 1; page_num <= 20; page_num++) {
    for (const endpoint of [
      `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-ranking?page=${page_num}&size=50&days=30`,
      `https://www.xt.com/fapi/user/v1/public/copy-trade/all-leader-list?page=${page_num}&pageSize=50`,
      `https://www.xt.com/fapi/user/v1/public/copy-trade/leader-list?page=${page_num}&size=50&sortType=INCOME_RATE`,
    ]) {
      try {
        const resp = await fetch(endpoint, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Cookie': cookieStr,
            'Origin': 'https://www.xt.com',
            'Referer': 'https://www.xt.com/en/copy-trading/futures',
          },
        })
        if (!resp.ok) continue
        const json = await resp.json()
        
        let items = []
        if (json?.result?.records) items = json.result.records
        else if (json?.result?.items) items = json.result.items
        else if (Array.isArray(json?.result)) {
          for (const cat of json.result) {
            if (cat.items?.length) items.push(...cat.items)
          }
        }
        
        if (items.length > 0) {
          for (const t of items) {
            const id = String(t.accountId || t.uid || '')
            const avatar = t.avatar || null
            if (id && avatar) avatarMap.set(id, avatar)
          }
          console.log(`  API page ${page_num} (${endpoint.split('?')[0].split('/').pop()}): +${items.length}, total ${avatarMap.size}`)
          if (items.length < 50) break
        }
      } catch {}
    }
    if (avatarMap.size >= 500) break
  }

  await browser.close()
  console.log(`\nTotal XT avatars: ${avatarMap.size}`)

  // Match and update
  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (!avatar) continue

    if (!DRY_RUN) {
      const { error } = await supabase
        .from('trader_sources')
        .update({ avatar_url: avatar })
        .eq('id', t.id)
      if (!error) updated++
    } else {
      updated++
    }
  }

  console.log(`\n✅ XT: ${updated}/${traders.length} avatars updated ${DRY_RUN ? '(DRY RUN)' : ''}`)
  
  // If many are still missing, use XT's default avatar
  const remaining = traders.length - updated
  if (remaining > 0) {
    console.log(`\n⚠ ${remaining} XT traders still without avatar`)
    // Check if there's a common XT default avatar from the data we got
    const avatarCounts = {}
    for (const [, url] of avatarMap) {
      avatarCounts[url] = (avatarCounts[url] || 0) + 1
    }
    const sorted = Object.entries(avatarCounts).sort((a, b) => b[1] - a[1])
    if (sorted.length) {
      console.log(`Most common XT avatars:`)
      sorted.slice(0, 3).forEach(([url, count]) => console.log(`  ${count}x ${url}`))
    }
  }
}

main().catch(console.error)

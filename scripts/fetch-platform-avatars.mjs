#!/usr/bin/env node
/**
 * fetch-platform-avatars.mjs — Fetch real avatars from platforms that need browser/API access
 *
 * Handles: XT, LBank, and other platforms where avatars were missed
 * For on-chain platforms: checks if platform shows any avatar
 *
 * Usage: node scripts/fetch-platform-avatars.mjs [--source=xt|lbank|all] [--dry-run]
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'all'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── XT.com ──────────────────────────────────────────

async function fetchXTAvatars(browser) {
  console.log('\n🔄 XT.com — Fetching avatars via API intercept...')
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map() // accountId → avatar URL

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('elite-leader-list') && !url.includes('leader-list')) return
    try {
      const json = await response.json().catch(() => null)
      if (!json) return
      
      let items = []
      if (Array.isArray(json?.result)) {
        for (const cat of json.result) {
          if (cat.items?.length) items.push(...cat.items)
        }
      }
      
      for (const t of items) {
        const id = String(t.accountId || '')
        const avatar = t.avatar || null
        if (id && avatar) avatarMap.set(id, avatar)
      }
      console.log(`  📡 Intercepted: ${items.length} items, ${avatarMap.size} total avatars`)
    } catch {}
  })

  await page.goto('https://www.xt.com/en/copy-trading/futures', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  
  // Close popups
  for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I am not']) {
    const btn = page.getByRole('button', { name: text })
    if (await btn.count() > 0) await btn.first().click().catch(() => {})
  }
  await sleep(3000)

  // Scroll to load more
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
    const moreBtn = page.getByText(/load more|more|查看更多/i)
    if (await moreBtn.count() > 0) await moreBtn.first().click().catch(() => {})
    if (avatarMap.size >= 500) break
    console.log(`    Scroll ${i + 1}: ${avatarMap.size} avatars`)
  }

  // Try all periods to get more traders
  for (const period of ['30 Days', '90 Days', '7 Days']) {
    const el = page.getByText(period, { exact: true })
    if (await el.count() > 0) {
      await el.first().click().catch(() => {})
      await sleep(3000)
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(2000)
        if (avatarMap.size >= 500) break
      }
      console.log(`  After ${period}: ${avatarMap.size} avatars`)
    }
  }

  await context.close()
  
  console.log(`  Total XT avatars found: ${avatarMap.size}`)
  return { source: 'xt', avatars: avatarMap }
}

// ── LBank ──────────────────────────────────────────

async function fetchLBankAvatars(browser) {
  console.log('\n🔄 LBank — Fetching avatars...')
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('leader') && !url.includes('trader')) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      
      // Try different response structures
      const lists = [json?.data?.list, json?.data?.items, json?.result?.list, json?.result?.items, json?.data]
      for (const list of lists) {
        if (!Array.isArray(list)) continue
        for (const t of list) {
          const id = String(t.traderId || t.uid || t.userId || t.id || '')
          const avatar = t.avatar || t.avatarUrl || t.headUrl || t.photo || t.img || null
          if (id && avatar) avatarMap.set(id, avatar)
        }
        if (list.length) {
          console.log(`  📡 LBank API: ${list.length} items, fields: ${Object.keys(list[0]).slice(0, 15).join(',')}`)
        }
      }
    } catch {}
  })

  // LBank copy trading URL
  for (const url of [
    'https://www.lbank.com/copy-trading',
    'https://www.lbank.com/en/copy-trading',
    'https://www.lbkrs.com/copy-trading',
  ]) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      await sleep(5000)
      if (avatarMap.size > 0) break
    } catch {}
  }

  // Scroll
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
  }

  await context.close()
  console.log(`  Total LBank avatars found: ${avatarMap.size}`)
  return { source: 'lbank', avatars: avatarMap }
}

// ── Update DB ──────────────────────────────────────────

async function updateAvatars({ source, avatars }) {
  if (avatars.size === 0) {
    console.log(`  ${source}: no avatars to update`)
    return 0
  }

  // Get traders missing avatars
  const PAGE_SIZE = 1000
  let traders = []
  let from = 0
  while (true) {
    const { data } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id')
      .eq('source', source)
      .is('avatar_url', null)
      .range(from, from + PAGE_SIZE - 1)
    if (!data?.length) break
    traders = traders.concat(data)
    from += PAGE_SIZE
    if (data.length < PAGE_SIZE) break
  }

  console.log(`  ${source}: ${traders.length} traders with null avatar, ${avatars.size} avatars available`)

  let updated = 0
  for (const t of traders) {
    const avatarUrl = avatars.get(t.source_trader_id)
    if (!avatarUrl) continue

    if (!DRY_RUN) {
      const { error } = await supabase
        .from('trader_sources')
        .update({ avatar_url: avatarUrl })
        .eq('id', t.id)
      
      if (!error) updated++
    } else {
      updated++
    }
  }

  console.log(`  ✅ ${source}: ${updated} avatars updated ${DRY_RUN ? '(DRY RUN)' : ''}`)
  return updated
}

// ── Main ──────────────────────────────────────────

async function main() {
  console.log(`\n🖼️ Platform Avatar Fetcher ${DRY_RUN ? '(DRY RUN)' : ''}`)
  
  const browser = await chromium.launch({ headless: true })
  
  try {
    if (SOURCE_FILTER === 'all' || SOURCE_FILTER === 'xt') {
      const xtResult = await fetchXTAvatars(browser)
      await updateAvatars(xtResult)
    }
    
    if (SOURCE_FILTER === 'all' || SOURCE_FILTER === 'lbank') {
      const lbankResult = await fetchLBankAvatars(browser)
      await updateAvatars(lbankResult)
    }
  } finally {
    await browser.close()
  }

  // Final stats
  const { count: remaining } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .is('avatar_url', null)
  console.log(`\n📊 Remaining null avatars: ${remaining}`)
}

main().catch(console.error)

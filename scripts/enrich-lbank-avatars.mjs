#!/usr/bin/env node
/**
 * enrich-lbank-avatars.mjs
 * 通过 nickname 匹配补充 LBank 头像
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchLBankAvatars() {
  console.log('\n🔄 Fetching LBank avatars from API...')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  const avatarMap = new Map() // nickname.toLowerCase() → avatar URL

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('leader') && !url.includes('trader')) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      const lists = [json?.data?.list, json?.data?.items, json?.result?.list, json?.result?.items, json?.data]
      for (const list of lists) {
        if (!Array.isArray(list)) continue
        for (const t of list) {
          const nickname = (t.nickname || t.nickName || t.name || '').trim()
          const avatar = t.headPhoto || t.avatar || t.avatarUrl || t.photo || null

          if (nickname && avatar) {
            // 使用小写+清理后的 nickname 作为 key
            const normalizedNickname = nickname.toLowerCase()
            avatarMap.set(normalizedNickname, avatar)
          }
        }
      }
    } catch {}
  })

  // Try multiple URLs
  for (const url of [
    'https://www.lbank.com/copy-trading',
    'https://www.lbank.com/en/copy-trading',
    'https://www.lbkrs.com/copy-trading',
  ]) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      await sleep(5000)

      // Scroll to load more
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(2000)
      }

      if (avatarMap.size > 10) break
    } catch {}
  }

  await browser.close()

  console.log(`  ✅ Total avatars from API: ${avatarMap.size}`)
  return avatarMap
}

async function updateDatabase(avatarMap) {
  console.log('\n🔄 Updating database via nickname matching...')

  // Get traders without avatars
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle')
    .eq('source', 'lbank')
    .is('avatar_url', null)

  if (error) {
    console.error('Error fetching traders:', error)
    return
  }

  console.log(`  Found ${traders.length} LBank traders without avatars`)

  let updated = 0
  let notFound = 0

  for (const trader of traders) {
    if (!trader.handle) {
      notFound++
      continue
    }

    // Try exact match (case-insensitive)
    const normalizedHandle = trader.handle.toLowerCase().trim()
    let avatarUrl = avatarMap.get(normalizedHandle)

    // If no exact match, try fuzzy match (remove special chars)
    if (!avatarUrl) {
      const cleanHandle = normalizedHandle.replace(/[^a-z0-9]/g, '')
      for (const [nick, url] of avatarMap.entries()) {
        const cleanNick = nick.replace(/[^a-z0-9]/g, '')
        if (cleanHandle === cleanNick) {
          avatarUrl = url
          console.log(`  🔍 Fuzzy match: "${trader.handle}" ≈ "${nick}"`)
          break
        }
      }
    }

    if (avatarUrl) {
      if (!DRY_RUN) {
        const { error: updateError } = await supabase
          .from('trader_sources')
          .update({ avatar_url: avatarUrl })
          .eq('id', trader.id)

        if (!updateError) {
          updated++
          console.log(`  ✓ Updated: ${trader.handle}`)
        } else {
          console.error(`  ✗ Error updating ${trader.handle}:`, updateError)
        }
      } else {
        updated++
        console.log(`  [DRY] Would update: ${trader.handle}`)
      }
    } else {
      notFound++
    }
  }

  console.log(`\n✅ Results ${DRY_RUN ? '(DRY RUN)' : ''}:`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Not found: ${notFound}`)
}

async function main() {
  console.log(`\n🖼️ LBank Avatar Enrichment (Nickname Matching) ${DRY_RUN ? '(DRY RUN)' : ''}`)

  const avatarMap = await fetchLBankAvatars()

  if (avatarMap.size === 0) {
    console.log('\n⚠️ No avatars found from API, exiting...')
    return
  }

  await updateDatabase(avatarMap)

  // Final stats
  const { count: remaining } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'lbank')
    .is('avatar_url', null)

  console.log(`\n📊 Remaining LBank traders without avatars: ${remaining}`)
}

main().catch(console.error)

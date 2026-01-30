#!/usr/bin/env node
/**
 * enrich-xt-from-profiles.mjs
 * 从 XT 交易员详情页抓取头像
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '100')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchAvatarFromProfile(page, profileUrl, traderId) {
  try {
    await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 30000 })
    await sleep(2000)

    // 尝试多种选择器找头像
    const avatar = await page.evaluate(() => {
      const selectors = [
        'img[alt*="avatar"]',
        'img[class*="avatar"]',
        'img[class*="Avatar"]',
        'img[src*="avatar"]',
        '[class*="avatar"] img',
        '[class*="Avatar"] img',
        '[class*="profile"] img',
        '[class*="trader-info"] img',
        '.avatar img',
        '.profile-avatar img',
      ]

      for (const selector of selectors) {
        const img = document.querySelector(selector)
        if (img && img.src && !img.src.includes('default')) {
          return img.src
        }
      }

      // 如果找不到，尝试找第一个看起来像头像的图片（正方形，小尺寸）
      const allImages = document.querySelectorAll('img')
      for (const img of allImages) {
        if (img.naturalWidth > 0 && img.naturalWidth === img.naturalHeight && img.naturalWidth < 300) {
          if (img.src && !img.src.includes('logo') && !img.src.includes('icon')) {
            return img.src
          }
        }
      }

      return null
    })

    return avatar
  } catch (error) {
    console.error(`  ✗ Error fetching ${traderId}:`, error.message)
    return null
  }
}

async function main() {
  console.log(`\n🖼️ XT Avatar Enrichment (Profile Page) ${DRY_RUN ? '(DRY RUN)' : ''}`)
  console.log(`Limit: ${LIMIT} traders\n`)

  // Get traders without avatars, ordered by most recent snapshots
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle, profile_url')
    .eq('source', 'xt')
    .is('avatar_url', null)
    .not('profile_url', 'is', null)
    .limit(LIMIT)

  if (error) {
    console.error('Error fetching traders:', error)
    return
  }

  console.log(`📊 Found ${traders.length} XT traders to process`)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  let updated = 0
  let failed = 0

  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i]

    console.log(`\n[${i + 1}/${traders.length}] Processing ${trader.source_trader_id} (${trader.handle})...`)

    const avatar = await fetchAvatarFromProfile(page, trader.profile_url, trader.source_trader_id)

    if (avatar) {
      console.log(`  ✓ Found avatar: ${avatar.substring(0, 60)}...`)

      if (!DRY_RUN) {
        const { error: updateError } = await supabase
          .from('trader_sources')
          .update({ avatar_url: avatar })
          .eq('id', trader.id)

        if (!updateError) {
          updated++
        } else {
          console.error(`  ✗ DB update error:`, updateError)
          failed++
        }
      } else {
        updated++
      }
    } else {
      console.log(`  ✗ No avatar found`)
      failed++
    }

    // Rate limiting
    if ((i + 1) % 10 === 0) {
      console.log(`\n⏸️  Progress: ${updated} updated, ${failed} failed. Pausing 5s...`)
      await sleep(5000)
    } else {
      await sleep(1000)
    }
  }

  await browser.close()

  console.log(`\n✅ Final Results ${DRY_RUN ? '(DRY RUN)' : ''}:`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Failed: ${failed}`)

  // Final stats
  const { count: remaining } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'xt')
    .is('avatar_url', null)

  console.log(`\n📊 Remaining XT traders without avatars: ${remaining}`)
}

main().catch(console.error)

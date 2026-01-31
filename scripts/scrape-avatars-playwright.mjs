#!/usr/bin/env node
/**
 * scrape-avatars-playwright.mjs
 * Visit individual trader profile pages via Playwright and extract avatar URLs.
 *
 * Usage:
 *   node scripts/scrape-avatars-playwright.mjs [--source=xt] [--limit=50] [--dry-run] [--headless]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const HEADLESS = process.argv.includes('--headless')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Default/placeholder patterns to reject
const REJECT_PATTERNS = [
  'default', 'placeholder', 'avatar-default', 'no-avatar', 'dicebear',
  'blockie', 'data:image', 'svg+xml', 'gradient', 'identicon',
  'blank.gif', '1x1', 'transparent', 'become-a-lead', 'logo',
  'icon', 'banner', 'favicon', 'loading', 'spinner', 'empty',
  'zendesk', 'intercom', 'crisp', 'livechat', 'chatbot', 'widget',
]

function isValidAvatar(url) {
  if (!url || url.length < 10) return false
  if (url.endsWith('.svg')) return false // SVGs are typically icons, not avatars
  const lower = url.toLowerCase()
  return !REJECT_PATTERNS.some(p => lower.includes(p))
}

// API response field names that contain avatar URLs, per platform
// When visiting a profile page, we intercept JSON API responses and extract avatar from these fields
const API_AVATAR_FIELDS = {
  xt: ['avatar', 'avatarUrl', 'headImg', 'photo', 'imgUrl'],
  coinex: ['avatar', 'avatarUrl', 'head_img', 'photo'],
  binance_futures: ['userPhotoUrl', 'userPhoto', 'avatar', 'photoUrl', 'photo'],
  binance_spot: ['userPhotoUrl', 'userPhoto', 'avatar', 'photoUrl'],
  binance_web3: ['avatar', 'photoUrl', 'userPhoto'],
  htx_futures: ['imgUrl', 'avatar', 'headImg', 'photo'],
  lbank: ['avatar', 'avatarUrl', 'headImg', 'head_img'],
  weex: ['headPic', 'avatar', 'headUrl', 'headImg'],
  bingx: ['headUrl', 'avatar', 'avatarUrl', 'headPic'],
  okx_futures: ['portLink', 'avatar', 'avatarUrl', 'portrait'],
  blofin: ['avatar', 'avatarUrl', 'portraitLink'],
  bitget_spot: ['traderImg', 'avatar', 'avatarUrl', 'photo'],
}

// Platform-specific avatar extraction strategies
const PLATFORM_CONFIG = {
  xt: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.trader-info img',
      '.profile-header img',
      '.user-info img',
      'img[class*="head"]',
      'img[class*="photo"]',
    ],
    networkPatterns: ['avatar', 'headImg', 'userImg', 'photo'],
    profileUrlTemplate: id => `https://www.xt.com/en/copy-trading/trader/${id}`,
    waitSelector: '[class*="trader"], [class*="profile"], [class*="detail"]',
  },
  coinex: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.trader-avatar img',
      '.user-avatar img',
      '.profile img',
      'img[class*="head"]',
    ],
    networkPatterns: ['avatar', 'headImg', 'photo', 'userImg'],
    profileUrlTemplate: id => `https://www.coinex.com/copy-trading/trader/${id}`,
    waitSelector: '[class*="trader"], [class*="profile"], [class*="detail"]',
  },
  binance_futures: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.portfolio-header img',
      '.trader-info img',
      'img[class*="photo"]',
      'img[class*="profile"]',
      'img[class*="head"]',
    ],
    networkPatterns: ['avatar', 'userPhoto', 'headImg'],
    profileUrlTemplate: id => `https://www.binance.com/en/copy-trading/lead-details/${id}`,
    waitSelector: '[class*="portfolio"], [class*="trader"], [class*="detail"], [class*="lead"]',
  },
  binance_spot: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.portfolio-header img',
      '.trader-info img',
      'img[class*="photo"]',
    ],
    networkPatterns: ['avatar', 'userPhoto'],
    profileUrlTemplate: id => `https://www.binance.com/en/copy-trading/lead-details/${id}?type=spot`,
    waitSelector: '[class*="portfolio"], [class*="trader"], [class*="detail"]',
  },
  binance_web3: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.profile img',
      'img[class*="head"]',
    ],
    networkPatterns: ['avatar', 'photo'],
    profileUrlTemplate: id => `https://www.binance.com/en/web3/social-tracker/${id}`,
    waitSelector: '[class*="profile"], [class*="social"], [class*="tracker"]',
  },
  htx_futures: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.leader-info img',
      '.trader-info img',
      'img[class*="head"]',
      'img[class*="photo"]',
    ],
    networkPatterns: ['avatar', 'imgUrl', 'headImg', 'hbfile'],
    profileUrlTemplate: id => `https://futures.htx.com/en-us/copytrading/futures/detail/${id}`,
    waitSelector: '[class*="leader"], [class*="trader"], [class*="detail"], [class*="copy"]',
  },
  lbank: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.trader-avatar img',
      '.user-info img',
      'img[class*="head"]',
    ],
    networkPatterns: ['avatar', 'traderHead', 'headImg'],
    profileUrlTemplate: id => `https://www.lbank.com/copy-trading/trader/${id}`,
    waitSelector: '[class*="trader"], [class*="profile"], [class*="detail"]',
  },
  weex: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.trader-info img',
      'img[class*="head"]',
    ],
    networkPatterns: ['avatar', 'headImg'],
    profileUrlTemplate: id => `https://www.weex.com/copy-trading/trader/${id}`,
    waitSelector: '[class*="trader"], [class*="detail"]',
  },
  bingx: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.trader-info img',
      'img[class*="head"]',
      'img[class*="photo"]',
    ],
    networkPatterns: ['avatar', 'headUrl', 'photo'],
    profileUrlTemplate: id => `https://bingx.com/en/CopyTrading/tradeDetail/${id}`,
    waitSelector: '[class*="trader"], [class*="detail"], [class*="copy"]',
  },
  okx_futures: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.lead-trader img',
      'img[class*="portrait"]',
      'img[class*="head"]',
    ],
    networkPatterns: ['avatar', 'portLink', 'portrait'],
    profileUrlTemplate: id => `https://www.okx.com/copy-trading/account/${id}`,
    waitSelector: '[class*="trader"], [class*="account"], [class*="copy"]',
  },
  blofin: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.trader-info img',
      'img[class*="head"]',
    ],
    networkPatterns: ['avatar', 'portrait'],
    profileUrlTemplate: id => `https://blofin.com/copy-trading/trader/${id}`,
    waitSelector: '[class*="trader"], [class*="detail"]',
  },
  bitget_spot: {
    selectors: [
      'img[class*="avatar"]',
      'img[class*="Avatar"]',
      '.trader-info img',
      'img[class*="head"]',
      'img[class*="photo"]',
    ],
    networkPatterns: ['avatar', 'traderImg', 'photo'],
    profileUrlTemplate: id => `https://www.bitget.com/copy-trading/trader?traderUid=${id}`,
    waitSelector: '[class*="trader"], [class*="detail"]',
  },
}

// Get traders with missing avatars
async function getMissingTraders(source) {
  const all = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id, handle, profile_url')
      .eq('source', source)
      .is('avatar_url', null)
      .range(from, from + 999)
    if (error || !data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return LIMIT > 0 ? all.slice(0, LIMIT) : all
}

// Extract avatar from a loaded page using multiple strategies
async function extractAvatar(page, config) {
  // Strategy 1: CSS selectors
  for (const selector of config.selectors) {
    try {
      const imgs = await page.$$(selector)
      for (const img of imgs) {
        const src = await img.getAttribute('src')
        if (isValidAvatar(src)) return src
      }
    } catch {}
  }

  // Strategy 2: All images, pick the first avatar-like one (small, in header area)
  try {
    const avatar = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img')
      for (const img of imgs) {
        const src = img.src || ''
        const rect = img.getBoundingClientRect()
        // Avatar images are typically: in top 400px, small (20-200px), and have avatar-like patterns
        if (rect.top < 400 && rect.width > 20 && rect.width < 200 && rect.height > 20 && rect.height < 200) {
          if (src.startsWith('http') && !src.includes('logo') && !src.includes('icon') && !src.includes('banner')) {
            return src
          }
        }
      }
      return null
    })
    if (isValidAvatar(avatar)) return avatar
  } catch {}

  // Strategy 3: Background images on avatar-like elements
  try {
    const bgAvatar = await page.evaluate(() => {
      const selectors = [
        '[class*="avatar"]', '[class*="Avatar"]',
        '[class*="photo"]', '[class*="head-img"]',
        '[class*="portrait"]', '[class*="profile-img"]',
      ]
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (!el) continue
        const bg = getComputedStyle(el).backgroundImage
        if (bg && bg !== 'none') {
          const match = bg.match(/url\(["']?(.*?)["']?\)/)
          if (match?.[1]) return match[1]
        }
      }
      return null
    })
    if (isValidAvatar(bgAvatar)) return bgAvatar
  } catch {}

  return null
}

async function scrapeAvatarsForPlatform(browser, source) {
  const config = PLATFORM_CONFIG[source]
  if (!config) {
    console.log(`  No config for ${source}, skipping`)
    return 0
  }

  const traders = await getMissingTraders(source)
  if (!traders.length) {
    console.log(`  No missing avatars for ${source}`)
    return 0
  }

  console.log(`\n--- ${source}: ${traders.length} traders need avatars ---`)

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()

  // Track avatars found from API response interception
  let apiAvatarUrl = null
  const avatarFields = API_AVATAR_FIELDS[source] || ['avatar', 'avatarUrl', 'photo']

  // Intercept JSON API responses to find avatar URL
  page.on('response', async (response) => {
    const contentType = response.headers()['content-type'] || ''
    if (!contentType.includes('json')) return
    try {
      const json = await response.json().catch(() => null)
      if (!json) return

      // Recursively search JSON for avatar fields
      const findAvatar = (obj, depth = 0) => {
        if (!obj || depth > 5) return null
        if (typeof obj === 'string') return null
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const found = findAvatar(item, depth + 1)
            if (found) return found
          }
          return null
        }
        if (typeof obj === 'object') {
          for (const field of avatarFields) {
            const val = obj[field]
            if (typeof val === 'string' && val.startsWith('http') && isValidAvatar(val)) {
              return val
            }
          }
          for (const val of Object.values(obj)) {
            const found = findAvatar(val, depth + 1)
            if (found) return found
          }
        }
        return null
      }

      const found = findAvatar(json)
      if (found) apiAvatarUrl = found
    } catch {}
  })

  // Also track avatar image requests
  const networkAvatars = new Map()
  page.on('response', async (response) => {
    const url = response.url()
    const contentType = response.headers()['content-type'] || ''
    if (contentType.startsWith('image/') && !url.endsWith('.svg') && config.networkPatterns.some(p => url.toLowerCase().includes(p))) {
      networkAvatars.set('latest', url)
    }
  })

  let updated = 0
  let failed = 0
  let noAvatar = 0

  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i]

    // Determine profile URL
    let profileUrl = trader.profile_url
    if (!profileUrl || profileUrl.includes('default') || !profileUrl.startsWith('http')) {
      profileUrl = config.profileUrlTemplate(trader.source_trader_id)
    }

    try {
      networkAvatars.clear()
      apiAvatarUrl = null

      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })

      // Wait for content
      try {
        await page.waitForSelector(config.waitSelector, { timeout: 8000 })
      } catch {
        // May not find selector, continue with what's loaded
      }
      await sleep(2500) // Let API calls complete and images load

      // Close any popups on first visit
      if (i === 0) {
        for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I understand', 'I am not']) {
          try {
            const btn = page.getByRole('button', { name: text })
            if (await btn.count() > 0) await btn.first().click({ timeout: 1000 }).catch(() => {})
          } catch {}
        }
        await sleep(1000)
      }

      // Strategy 1: Use avatar from intercepted API response (most reliable)
      let avatarUrl = apiAvatarUrl

      // Strategy 2: DOM extraction
      if (!avatarUrl) {
        avatarUrl = await extractAvatar(page, config)
      }

      // Strategy 3: Network-intercepted image avatar
      if (!avatarUrl && networkAvatars.has('latest')) {
        avatarUrl = networkAvatars.get('latest')
      }

      if (avatarUrl && isValidAvatar(avatarUrl)) {
        if (!DRY_RUN) {
          const { error } = await supabase
            .from('trader_sources')
            .update({ avatar_url: avatarUrl })
            .eq('id', trader.id)
          if (!error) {
            updated++
            console.log(`  [${updated}] ${trader.handle || trader.source_trader_id} -> ${avatarUrl.substring(0, 80)}`)
          } else {
            failed++
          }
        } else {
          updated++
          console.log(`  [DRY] ${trader.handle} -> ${avatarUrl.substring(0, 80)}`)
        }
      } else {
        noAvatar++
        if (noAvatar <= 5) {
          console.log(`  [-] ${trader.handle || trader.source_trader_id} (no avatar found)`)
        }
      }
    } catch (err) {
      failed++
      if (failed <= 3) {
        console.log(`  [!] ${trader.handle || trader.source_trader_id}: ${err.message?.substring(0, 60)}`)
      }
    }

    // Progress
    if ((i + 1) % 20 === 0) {
      console.log(`  Progress: ${i + 1}/${traders.length} (${updated} updated, ${noAvatar} no avatar, ${failed} failed)`)
    }

    // Rate limiting - slower for exchanges that may block
    await sleep(2000 + Math.random() * 2000)
  }

  await context.close()

  console.log(`  ${source}: ${updated}/${traders.length} updated, ${noAvatar} no avatar, ${failed} failed`)
  return updated
}

async function fixBadProfileUrls() {
  // Fix binance_spot profile URLs (stored as default avatar image URLs)
  const { data: badBinance } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, profile_url')
    .eq('source', 'binance_spot')
    .like('profile_url', '%default-avatar%')

  if (badBinance?.length) {
    console.log(`Fixing ${badBinance.length} binance_spot profile URLs...`)
    for (const t of badBinance) {
      await supabase
        .from('trader_sources')
        .update({ profile_url: `https://www.binance.com/en/copy-trading/lead-details/${t.source_trader_id}?type=spot` })
        .eq('id', t.id)
    }
  }

  // Fix bitget_spot profile URLs
  const { data: badBitget } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, profile_url')
    .eq('source', 'bitget_spot')
    .like('profile_url', '%avatar-default%')

  if (badBitget?.length) {
    console.log(`Fixing ${badBitget.length} bitget_spot profile URLs...`)
    for (const t of badBitget) {
      await supabase
        .from('trader_sources')
        .update({ profile_url: `https://www.bitget.com/copy-trading/trader?traderUid=${t.source_trader_id}` })
        .eq('id', t.id)
    }
  }
}

// Prioritize platforms by missing count
const PLATFORM_PRIORITY = [
  'xt',              // 180 missing
  'coinex',          // 45 missing
  'binance_futures', // 39 missing
  'binance_web3',    // 17 missing
  'htx_futures',     // 16 missing
  'lbank',           // 16 missing
  'binance_spot',    // 11 missing
  'weex',            // 5 missing
  'bingx',           // 4 missing
  'okx_futures',     // 3 missing
  'blofin',          // 3 missing
  'bitget_spot',     // 2 missing
]

async function main() {
  console.log(`\nPlaywright Avatar Scraper ${DRY_RUN ? '(DRY RUN)' : ''} ${HEADLESS ? '(headless)' : '(headed)'}`)
  console.log(`Source: ${SOURCE_FILTER || 'all'}, Limit: ${LIMIT || 'none'}\n`)

  // Fix bad profile URLs first
  await fixBadProfileUrls()

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const sources = SOURCE_FILTER
    ? [SOURCE_FILTER]
    : PLATFORM_PRIORITY

  let totalUpdated = 0

  for (const source of sources) {
    try {
      totalUpdated += await scrapeAvatarsForPlatform(browser, source)
    } catch (err) {
      console.error(`  Error for ${source}:`, err.message)
    }
  }

  await browser.close()

  console.log(`\n========================================`)
  console.log(`Total updated: ${totalUpdated}`)
  console.log(`========================================\n`)
}

main().catch(console.error)

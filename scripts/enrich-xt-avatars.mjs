#!/usr/bin/env node
/**
 * enrich-xt-avatars.mjs
 * 从 XT.com 页面 DOM 抓取头像
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchXTAvatarsFromDOM() {
  console.log('\n🔄 Fetching XT avatars from page DOM...')

  const browser = await chromium.launch({ headless: false }) // 非 headless 便于调试
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()

  const avatarMap = new Map() // accountId → avatar URL

  // 拦截 API 获取 accountId
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
        const accountId = String(t.accountId || '')
        const nickname = t.nickName || ''
        if (accountId) {
          // 先存储 accountId 和 nickname 映射，稍后通过 DOM 找头像
          if (!avatarMap.has(accountId)) {
            avatarMap.set(accountId, { nickname, avatar: null })
          }
        }
      }
    } catch {}
  })

  await page.goto('https://www.xt.com/en/copy-trading/futures', {
    waitUntil: 'networkidle',
    timeout: 60000
  }).catch(() => {})

  // Close popups
  await sleep(3000)
  for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I am not']) {
    const btn = page.getByRole('button', { name: text })
    if (await btn.count() > 0) await btn.first().click().catch(() => {})
  }
  await sleep(2000)

  console.log(`  📊 Found ${avatarMap.size} traders from API`)

  // 滚动加载更多
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
  }

  // 从 DOM 提取头像
  console.log('\n🔍 Extracting avatars from DOM...')

  const tradersWithAvatars = await page.evaluate(() => {
    const traders = []

    // 尝试多种选择器找到交易员卡片
    const selectors = [
      '[class*="trader-card"]',
      '[class*="TraderCard"]',
      '[class*="leader-card"]',
      '[class*="LeaderCard"]',
      '[data-testid*="trader"]',
      '[class*="copy-trader"]',
    ]

    let cards = []
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector)
      if (elements.length > 0) {
        cards = Array.from(elements)
        break
      }
    }

    // 如果找不到卡片，尝试查找所有包含头像的元素
    if (cards.length === 0) {
      const avatarElements = document.querySelectorAll('img[src*="avatar"], img[alt*="avatar"], img[class*="avatar"]')
      console.log(`Found ${avatarElements.length} avatar images`)

      avatarElements.forEach(img => {
        const card = img.closest('[class*="card"], [class*="item"], [class*="row"]')
        if (card) {
          const nickname = card.textContent?.trim() || ''
          const avatar = img.src
          if (avatar && !avatar.includes('default')) {
            traders.push({ nickname: nickname.substring(0, 50), avatar })
          }
        }
      })
    } else {
      cards.forEach(card => {
        const img = card.querySelector('img')
        const nickname = card.textContent?.trim() || ''
        const avatar = img?.src

        if (avatar && !avatar.includes('default')) {
          traders.push({ nickname: nickname.substring(0, 50), avatar })
        }
      })
    }

    return traders
  })

  console.log(`  ✅ Extracted ${tradersWithAvatars.length} traders with avatars from DOM`)

  // 尝试通过 nickname 匹配
  let matched = 0
  for (const domTrader of tradersWithAvatars) {
    for (const [accountId, data] of avatarMap.entries()) {
      if (data.avatar) continue // 已有头像

      if (domTrader.nickname.includes(data.nickname) || data.nickname.includes(domTrader.nickname.split(/\s+/)[0])) {
        avatarMap.set(accountId, { ...data, avatar: domTrader.avatar })
        matched++
        console.log(`  🔗 Matched: ${data.nickname} → ${domTrader.avatar.substring(0, 60)}...`)
      }
    }
  }

  console.log(`\n  📊 Matched ${matched} avatars`)

  await browser.close()

  // 返回 accountId → avatar 映射
  const result = new Map()
  for (const [accountId, data] of avatarMap.entries()) {
    if (data.avatar) {
      result.set(accountId, data.avatar)
    }
  }

  return result
}

async function updateDatabase(avatarMap) {
  console.log('\n🔄 Updating database...')

  // Get traders without avatars
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle')
    .eq('source', 'xt')
    .is('avatar_url', null)

  if (error) {
    console.error('Error fetching traders:', error)
    return
  }

  console.log(`  Found ${traders.length} XT traders without avatars`)

  let updated = 0
  let notFound = 0

  for (const trader of traders) {
    const avatarUrl = avatarMap.get(trader.source_trader_id)

    if (avatarUrl) {
      if (!DRY_RUN) {
        const { error: updateError } = await supabase
          .from('trader_sources')
          .update({ avatar_url: avatarUrl })
          .eq('id', trader.id)

        if (!updateError) {
          updated++
          if (updated % 10 === 0) {
            console.log(`  ✓ Updated ${updated} traders...`)
          }
        } else {
          console.error(`  ✗ Error updating ${trader.handle}:`, updateError)
        }
      } else {
        updated++
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
  console.log(`\n🖼️ XT Avatar Enrichment (DOM Extraction) ${DRY_RUN ? '(DRY RUN)' : ''}`)

  const avatarMap = await fetchXTAvatarsFromDOM()

  console.log(`\n📊 Total avatars extracted: ${avatarMap.size}`)

  if (avatarMap.size === 0) {
    console.log('\n⚠️ No avatars found, exiting...')
    return
  }

  await updateDatabase(avatarMap)

  // Final stats
  const { count: remaining } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'xt')
    .is('avatar_url', null)

  console.log(`\n📊 Remaining XT traders without avatars: ${remaining}`)
}

main().catch(console.error)

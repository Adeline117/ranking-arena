#!/usr/bin/env node
/**
 * backfill-avatars-browser.mjs — Browser-based avatar backfill
 * 
 * Uses Playwright to visit platform leaderboard pages and intercept API responses
 * to capture avatars for traders that are missing them.
 * 
 * Usage: node scripts/backfill-avatars-browser.mjs [--source=bybit|mexc|...] [--dry-run]
 */
import 'dotenv/config'
import pg from 'pg'
const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL
const pool = new Pool({ connectionString: DATABASE_URL })

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Get missing traders for a source
async function getMissing(source) {
  const { rows } = await pool.query(
    `SELECT id, source_trader_id, handle, profile_url FROM trader_sources WHERE source = $1 AND avatar_url IS NULL`,
    [source]
  )
  return rows
}

// Update avatar
async function setAvatar(id, url) {
  if (DRY_RUN) return true
  const { rowCount } = await pool.query(
    'UPDATE trader_sources SET avatar_url = $1 WHERE id = $2 AND avatar_url IS NULL',
    [url, id]
  )
  return rowCount > 0
}

// Check if avatar URL is a real avatar (not default/placeholder/favicon)
function isRealAvatar(url) {
  if (!url || url.length < 10 || !url.startsWith('http')) return false
  const lower = url.toLowerCase()
  if (lower.includes('default') || lower.includes('placeholder') || lower.includes('favicon.ico')) return false
  if (lower.includes('/banner/')) return false // MEXC banner ads
  if (lower.includes('boringavatars.com') || lower.includes('dicebear') || lower.includes('identicon')) return false
  // Platform-specific default avatars
  if (lower.includes('a.static-global.com/public/1/thanos/copytrade/default')) return false
  if (lower.includes('9E1ABF1C25D53A92.png')) return false // OKX default
  if (lower.includes('cba5c7064793fae75b583023f22a6bca.png')) return false // Bitget default
  if (lower.includes('deadpool/image-f917004e66dc4ee9811dead815813194.svg')) return false // Bybit default
  return true
}

// ══════════════════════════════════════════════════════════
// BYBIT — Leaderboard scrape via API intercept
// ══════════════════════════════════════════════════════════
async function scrapeBybit() {
  console.log('\n═══ BYBIT ═══')
  const missing = await getMissing('bybit')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  
  const avatarMap = new Map()

  // Intercept API responses
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('leader') && !url.includes('beehive') && !url.includes('copy')) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      // Search for trader data in response
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = item.leaderMark || item.leaderId || item.uid || item.uniqueCode || ''
              const avatar = item.avatar || item.avatarUrl || item.leaderAvatar || ''
              if (id && isRealAvatar(avatar)) {
                avatarMap.set(String(id), avatar)
              }
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  // Visit leaderboard pages with different sort options
  for (const tab of ['ROI', 'PNL', 'FOLLOWERS', 'WIN_RATE', 'COPIERS']) {
    try {
      await page.goto(`https://www.bybit.com/copyTrading/tradeCenter`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleep(3000)
      
      // Close popups
      for (const sel of ['[class*="close"]', '[aria-label="Close"]', 'button:has-text("OK")', 'button:has-text("Got it")']) {
        try { await page.click(sel, { timeout: 1000 }) } catch {}
      }
      
      // Scroll to load more
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1500)
        // Click "Load more" type buttons
        try {
          const more = page.locator('button:has-text("Load"), button:has-text("More"), [class*="loadMore"]').first()
          if (await more.isVisible({ timeout: 500 })) await more.click()
        } catch {}
      }
      
      console.log(`  Bybit ${tab}: ${avatarMap.size} avatars collected`)
      if (avatarMap.size > 500) break
    } catch (e) {
      console.log(`  Bybit ${tab} error: ${e.message}`)
    }
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) {
      updated++
    }
  }
  console.log(`  Bybit: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// MEXC — Leaderboard scrape
// ══════════════════════════════════════════════════════════
async function scrapeMEXC() {
  console.log('\n═══ MEXC ═══')
  const missing = await getMissing('mexc')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))
  // Also map by handle for nickname matching
  const handleMap = new Map(missing.filter(t => t.handle).map(t => [t.handle, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  
  const avatarMap = new Map() // traderId -> avatar
  const nameAvatarMap = new Map() // nickname -> avatar

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('trader') && !url.includes('leader')) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.traderId || item.uid || item.userId || item.id || '')
              const name = item.nickName || item.nickname || item.name || ''
              let avatar = item.avatar || item.avatarUrl || item.headImg || item.photoUrl || ''
              
              if (isRealAvatar(avatar)) {
                if (id) avatarMap.set(id, avatar)
                if (name) nameAvatarMap.set(name, avatar)
              }
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://futures.mexc.com/en-US/copy-trade/square', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)

    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      try {
        const next = page.locator('[class*="next"]:not([disabled]), .ant-pagination-next:not(.ant-pagination-disabled)').first()
        if (await next.isVisible({ timeout: 500 })) await next.click()
      } catch {}
    }
  } catch (e) {
    console.log(`  MEXC error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const t of missing) {
    const avatar = avatarMap.get(t.source_trader_id) || nameAvatarMap.get(t.handle)
    if (avatar && await setAvatar(t.id, avatar)) {
      updated++
    }
  }
  console.log(`  MEXC: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// KUCOIN — Leaderboard scrape
// ══════════════════════════════════════════════════════════
async function scrapeKuCoin() {
  console.log('\n═══ KUCOIN ═══')
  const missing = await getMissing('kucoin')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('leader') && !url.includes('trade')) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.leaderId || item.traderId || item.uid || item.id || '')
              const avatar = item.avatar || item.avatarUrl || item.headImg || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://www.kucoin.com/copy-trading/leaderboard', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      try {
        const next = page.locator('[class*="next"]:not([disabled])').first()
        if (await next.isVisible({ timeout: 500 })) await next.click()
        await sleep(2000)
      } catch {}
    }
  } catch (e) {
    console.log(`  KuCoin error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  KuCoin: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// COINEX — Leaderboard scrape
// ══════════════════════════════════════════════════════════
async function scrapeCoinEx() {
  console.log('\n═══ COINEX ═══')
  const missing = await getMissing('coinex')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.traderId || item.uid || item.id || '')
              const avatar = item.avatar || item.avatarUrl || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://www.coinex.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) {
    console.log(`  CoinEx error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  CoinEx: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// LBANK — Leaderboard scrape
// ══════════════════════════════════════════════════════════
async function scrapeLBank() {
  console.log('\n═══ LBANK ═══')
  const missing = await getMissing('lbank')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.traderId || item.uid || item.userId || item.id || item.uuid || '')
              const avatar = item.avatar || item.avatarUrl || item.headUrl || item.headPhoto || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://www.lbank.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) {
    console.log(`  LBank error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  LBank: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// BITFINEX — Scrape leaderboard
// ══════════════════════════════════════════════════════════
async function scrapeBitfinex() {
  console.log('\n═══ BITFINEX ═══')
  const missing = await getMissing('bitfinex')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))
  const handleMap = new Map(missing.filter(t => t.handle).map(t => [t.handle.toLowerCase(), t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map() // handle -> avatar

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.username || item.handle || item.nickname || item.name || '')
              const avatar = item.avatar || item.avatarUrl || item.picture || item.image || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id.toLowerCase(), avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://leaderboard.bitfinex.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    
    // Extract from DOM too
    const domAvatars = await page.evaluate(() => {
      const results = []
      document.querySelectorAll('img').forEach(img => {
        const src = img.src
        if (!src || src.includes('favicon') || src.includes('logo')) return
        const row = img.closest('tr, [class*="row"], [class*="card"], li')
        if (row) {
          const text = row.textContent?.trim()
          results.push({ avatar: src, text: text?.slice(0, 100) })
        }
      })
      return results
    })
    console.log(`  DOM avatars: ${domAvatars.length}`)
    
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) {
    console.log(`  Bitfinex error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const t of missing) {
    const avatar = avatarMap.get(t.source_trader_id.toLowerCase()) || avatarMap.get(t.handle?.toLowerCase())
    if (avatar && await setAvatar(t.id, avatar)) updated++
  }
  console.log(`  Bitfinex: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// WEEX — Leaderboard scrape
// ══════════════════════════════════════════════════════════
async function scrapeWeex() {
  console.log('\n═══ WEEX ═══')
  const missing = await getMissing('weex')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.traderUserId || item.traderId || item.uid || item.id || '')
              const avatar = item.headPic || item.avatar || item.headUrl || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://www.weex.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) {
    console.log(`  Weex error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  Weex: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// BLOFIN — Leaderboard scrape
// ══════════════════════════════════════════════════════════
async function scrapeBlofin() {
  console.log('\n═══ BLOFIN ═══')
  const missing = await getMissing('blofin')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.uniqueName || item.traderId || item.uid || item.id || '')
              const avatar = item.portrait || item.portraitLink || item.avatar || item.avatarUrl || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://www.blofin.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) {
    console.log(`  Blofin error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  Blofin: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// TOOBIT — Leaderboard scrape
// ══════════════════════════════════════════════════════════
async function scrapeToobit() {
  console.log('\n═══ TOOBIT ═══')
  const missing = await getMissing('toobit')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.traderId || item.uid || item.id || '')
              const avatar = item.avatar || item.avatarUrl || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://www.toobit.com/en-US/copy-trading', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) {
    console.log(`  Toobit error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  Toobit: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// BINGX — Leaderboard scrape  
// ══════════════════════════════════════════════════════════
async function scrapeBingX() {
  console.log('\n═══ BINGX ═══')
  const missing = await getMissing('bingx')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.uniqueId || item.uid || item.traderId || item.id || '')
              const avatar = item.headUrl || item.avatar || item.avatarUrl || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://bingx.com/en/copy-trading/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) {
    console.log(`  BingX error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  BingX: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// GATEIO — Leaderboard scrape
// ══════════════════════════════════════════════════════════
async function scrapeGateIO() {
  console.log('\n═══ GATE.IO ═══')
  const missing = await getMissing('gateio')
  if (!missing.length) { console.log('  No missing avatars'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()

  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item) {
              const id = String(item.trader_id || item.traderId || item.uid || item.id || '')
              const avatar = item.avatar || item.avatar_url || item.head_img || ''
              if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') extract(val, depth + 1)
          }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://www.gate.io/copy_trading', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) {
    console.log(`  Gate.io error: ${e.message}`)
  }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  Gate.io: ${updated}/${missing.length} updated (found ${avatarMap.size} avatars)`)
  return updated
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════

const HANDLERS = {
  bybit: scrapeBybit,
  mexc: scrapeMEXC,
  kucoin: scrapeKuCoin,
  coinex: scrapeCoinEx,
  lbank: scrapeLBank,
  bitfinex: scrapeBitfinex,
  weex: scrapeWeex,
  blofin: scrapeBlofin,
  toobit: scrapeToobit,
  bingx: scrapeBingX,
  gateio: scrapeGateIO,
}

async function main() {
  console.log(`\n🖼️  Avatar Backfill (Browser) ${DRY_RUN ? '(DRY RUN)' : ''}`)
  console.log(`Platform: ${SOURCE_FILTER || 'all Mac-accessible platforms'}\n`)

  const sources = SOURCE_FILTER ? [SOURCE_FILTER] : Object.keys(HANDLERS)
  let totalUpdated = 0

  for (const source of sources) {
    const handler = HANDLERS[source]
    if (!handler) {
      console.log(`\n--- ${source}: no handler, skip ---`)
      continue
    }
    try {
      totalUpdated += await handler()
    } catch (err) {
      console.error(`  ${source} error:`, err.message)
    }
  }

  // Final stats
  const { rows } = await pool.query(`
    SELECT source, count(*) as total, count(avatar_url) as has_avatar, count(*) - count(avatar_url) as missing
    FROM trader_sources GROUP BY source ORDER BY (count(*) - count(avatar_url)) DESC LIMIT 20
  `)
  
  console.log('\n══════════════════════════════════')
  console.log(`Total updated: ${totalUpdated}`)
  console.log('══════════════════════════════════')
  console.log('\nRemaining missing (top 20):')
  console.table(rows)

  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })

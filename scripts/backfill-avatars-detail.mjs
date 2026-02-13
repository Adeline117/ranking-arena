#!/usr/bin/env node
/**
 * backfill-avatars-detail.mjs — Fetch avatars by visiting individual trader detail pages
 * 
 * For traders missing avatars, visits their profile page on each platform
 * and extracts the avatar URL from API responses or DOM.
 * 
 * Usage: node scripts/backfill-avatars-detail.mjs [--source=coinex|kucoin|mexc|...] [--limit=100] [--dry-run]
 */
import 'dotenv/config'
import pg from 'pg'
const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL
const pool = new Pool({ connectionString: DATABASE_URL })

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '500')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function isRealAvatar(url) {
  if (!url || url.length < 10 || !url.startsWith('http')) return false
  const lower = url.toLowerCase()
  const fakes = ['default', 'placeholder', 'favicon.ico', '/banner/F2', 'boringavatars', 'dicebear', 
    'identicon', '9E1ABF1C25D53A92', 'cba5c7064793fae75b583023f22a6bca', 'deadpool/image-f917004',
    'coinex_default_avatar']
  return !fakes.some(f => lower.includes(f.toLowerCase()))
}

async function getMissing(source, limit) {
  const { rows } = await pool.query(
    `SELECT id, source_trader_id, handle, profile_url FROM trader_sources WHERE source = $1 AND avatar_url IS NULL LIMIT $2`,
    [source, limit]
  )
  return rows
}

async function setAvatar(id, url) {
  if (DRY_RUN) return true
  const { rowCount } = await pool.query(
    'UPDATE trader_sources SET avatar_url = $1 WHERE id = $2 AND avatar_url IS NULL', [url, id]
  )
  return rowCount > 0
}

// ══════════════════════════════════════════════════════════
// CoinEx — Direct API (works from Mac)
// ══════════════════════════════════════════════════════════
async function backfillCoinEx() {
  console.log('\n═══ COINEX ═══')
  const missing = await getMissing('coinex', LIMIT)
  if (!missing.length) { console.log('  No missing'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  // First bulk fetch from leaderboard
  const avatarMap = new Map()
  for (const timeRange of ['DAY7', 'DAY30', 'DAY90']) {
    for (let page = 1; page <= 20; page++) {
      try {
        const r = await fetch(`https://www.coinex.com/res/copy-trading/public/traders?data_type=profit_rate&time_range=${timeRange}&hide_full=0&page=${page}&limit=100`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
        })
        const j = await r.json()
        if (!j?.data?.data?.length) break
        for (const t of j.data.data) {
          if (t.avatar && isRealAvatar(t.avatar)) avatarMap.set(t.trader_id, t.avatar)
        }
        if (!j.data.has_next) break
        await sleep(300)
      } catch { break }
    }
  }
  console.log(`  Leaderboard: ${avatarMap.size} real avatars`)

  let updated = 0
  const remaining = []
  for (const t of missing) {
    const avatar = avatarMap.get(t.source_trader_id)
    if (avatar && await setAvatar(t.id, avatar)) {
      updated++
    } else {
      remaining.push(t)
    }
  }

  // Individual detail API for remaining
  for (const t of remaining.slice(0, 200)) {
    try {
      const r = await fetch(`https://www.coinex.com/res/copy-trading/public/trader-detail?trader_id=${t.source_trader_id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })
      const j = await r.json()
      const avatar = j?.data?.avatar || j?.data?.avatar_url
      if (isRealAvatar(avatar) && await setAvatar(t.id, avatar)) {
        updated++
        if (updated % 10 === 0) console.log(`  [${updated}] ${t.handle}`)
      }
      await sleep(500)
    } catch {}
  }

  console.log(`  CoinEx: ${updated}/${missing.length} updated`)
  return updated
}

// ══════════════════════════════════════════════════════════
// MEXC — Browser scrape (Mac accessible)
// ══════════════════════════════════════════════════════════
async function backfillMEXC() {
  console.log('\n═══ MEXC ═══')
  const missing = await getMissing('mexc', LIMIT)
  if (!missing.length) { console.log('  No missing'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  // MEXC uses source_trader_id as numeric ID or nickname
  // Try the detail API via futures.mexc.com
  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))
  const handleMap = new Map(missing.filter(t => t.handle).map(t => [t.handle, t]))

  // Browser scrape leaderboard to collect avatars
  const puppeteer = (await import('puppeteer-extra')).default
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
  await page.setViewport({ width: 1920, height: 1080 })

  const avatarMap = new Map()

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
            if (typeof item !== 'object' || !item) continue
            const id = String(item.traderId || item.uid || item.userId || item.id || '')
            const name = item.nickName || item.nickname || item.name || ''
            const avatar = item.avatar || item.avatarUrl || item.headImg || item.photoUrl || item.userPhoto || ''
            if (isRealAvatar(avatar)) {
              if (id) avatarMap.set(id, avatar)
              if (name) avatarMap.set(name, avatar)
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
    await page.goto('https://futures.mexc.com/en-US/copy-trade/square', { waitUntil: 'networkidle2', timeout: 45000 })
    await sleep(3000)

    // Scroll and paginate
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
      // Try next page button
      try {
        const nextBtn = await page.$('.ant-pagination-next:not(.ant-pagination-disabled), [class*="next"]:not([disabled])')
        if (nextBtn) { await nextBtn.click(); await sleep(2000) }
      } catch {}
      if (avatarMap.size > 0 && i % 5 === 0) console.log(`  Page ${i+1}: ${avatarMap.size} avatars`)
    }
  } catch (e) {
    console.log(`  Browser error: ${e.message}`)
  }

  await browser.close()
  console.log(`  Collected ${avatarMap.size} avatars from leaderboard`)

  let updated = 0
  for (const t of missing) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get(t.handle)
    if (avatar && await setAvatar(t.id, avatar)) {
      updated++
    }
  }
  console.log(`  MEXC: ${updated}/${missing.length} updated`)
  return updated
}

// ══════════════════════════════════════════════════════════
// KuCoin — Browser scrape
// ══════════════════════════════════════════════════════════
async function backfillKuCoin() {
  console.log('\n═══ KUCOIN ═══')
  const missing = await getMissing('kucoin', LIMIT)
  if (!missing.length) { console.log('  No missing'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))

  const puppeteer = (await import('puppeteer-extra')).default
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
  await page.setViewport({ width: 1920, height: 1080 })

  const avatarMap = new Map()

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('copy') && !url.includes('leader') && !url.includes('kumex') && !url.includes('trade')) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      function extract(obj, depth = 0) {
        if (depth > 5 || !obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item !== 'object' || !item) continue
            const id = String(item.leaderId || item.traderId || item.uid || item.userId || item.id || '')
            const avatar = item.avatarUrl || item.avatar || item.headImg || ''
            if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
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
    await page.goto('https://www.kucoin.com/copy-trading/leaderboard', { waitUntil: 'networkidle2', timeout: 45000 })
    await sleep(3000)

    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
      try {
        const nextBtn = await page.$('[class*="next"]:not([disabled]), .ant-pagination-next:not(.ant-pagination-disabled)')
        if (nextBtn) { await nextBtn.click(); await sleep(2000) }
      } catch {}
      if (i % 5 === 0) console.log(`  Page ${i+1}: ${avatarMap.size} avatars`)
    }
  } catch (e) {
    console.log(`  Browser error: ${e.message}`)
  }

  await browser.close()
  console.log(`  Collected ${avatarMap.size} avatars`)

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  KuCoin: ${updated}/${missing.length} updated`)
  return updated
}

// ══════════════════════════════════════════════════════════
// Gate.io — Direct API
// ══════════════════════════════════════════════════════════
async function backfillGateIO() {
  console.log('\n═══ GATE.IO ═══')
  const missing = await getMissing('gateio', LIMIT)
  if (!missing.length) { console.log('  No missing'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))
  const avatarMap = new Map()

  // Browser scrape
  const puppeteer = (await import('puppeteer-extra')).default
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  await page.setViewport({ width: 1920, height: 1080 })

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
            if (typeof item !== 'object' || !item) continue
            const id = String(item.trader_id || item.traderId || item.uid || item.id || '')
            const avatar = item.avatar || item.avatar_url || item.head_img || ''
            if (id && isRealAvatar(avatar)) avatarMap.set(id, avatar)
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) { if (typeof val === 'object') extract(val, depth + 1) }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto('https://www.gate.io/copy_trading', { waitUntil: 'networkidle2', timeout: 45000 })
    await sleep(3000)
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) { console.log(`  Error: ${e.message}`) }

  await browser.close()

  let updated = 0
  for (const [id, avatar] of avatarMap) {
    const trader = missingMap.get(id)
    if (trader && await setAvatar(trader.id, avatar)) updated++
  }
  console.log(`  Gate.io: ${updated}/${missing.length} updated (found ${avatarMap.size})`)
  return updated
}

// ══════════════════════════════════════════════════════════
// Weex, Blofin, Toobit, BingX, LBank — Browser scrape
// ══════════════════════════════════════════════════════════
async function backfillGenericBrowser(source, url) {
  console.log(`\n═══ ${source.toUpperCase()} ═══`)
  const missing = await getMissing(source, LIMIT)
  if (!missing.length) { console.log('  No missing'); return 0 }
  console.log(`  ${missing.length} traders need avatars`)

  const missingMap = new Map(missing.map(t => [t.source_trader_id, t]))
  const handleMap = new Map(missing.filter(t => t.handle).map(t => [t.handle, t]))

  const puppeteer = (await import('puppeteer-extra')).default
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  await page.setViewport({ width: 1920, height: 1080 })

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
            if (typeof item !== 'object' || !item) continue
            // Try all common ID fields
            const id = String(item.traderId || item.traderUserId || item.uid || item.userId || 
              item.id || item.leaderId || item.uniqueId || item.uniqueName || item.leaderMark || '')
            const name = item.nickName || item.nickname || item.name || item.displayName || ''
            const avatar = item.avatar || item.avatarUrl || item.headPic || item.headUrl || 
              item.headImg || item.photoUrl || item.portrait || item.portraitLink || item.userPhoto || ''
            if (isRealAvatar(avatar)) {
              if (id) avatarMap.set(id, avatar)
              if (name) avatarMap.set(name, avatar)
            }
          }
        }
        if (typeof obj === 'object' && !Array.isArray(obj)) {
          for (const val of Object.values(obj)) { if (typeof val === 'object') extract(val, depth + 1) }
        }
      }
      extract(json)
    } catch {}
  })

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
    await sleep(3000)
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
    }
  } catch (e) { console.log(`  Error: ${e.message}`) }

  await browser.close()
  console.log(`  Collected ${avatarMap.size} avatars`)

  let updated = 0
  for (const t of missing) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get(t.handle)
    if (avatar && await setAvatar(t.id, avatar)) updated++
  }
  console.log(`  ${source}: ${updated}/${missing.length} updated`)
  return updated
}

// ══════════════════════════════════════════════════════════
// Bybit — Individual profile pages (has profile_url)
// ══════════════════════════════════════════════════════════
async function backfillBybitDetail() {
  console.log('\n═══ BYBIT (detail pages) ═══')
  const missing = await getMissing('bybit', LIMIT)
  if (!missing.length) { console.log('  No missing'); return 0 }
  
  const withUrl = missing.filter(t => t.profile_url)
  console.log(`  ${missing.length} need avatars, ${withUrl.length} have profile URLs`)

  const puppeteer = (await import('puppeteer-extra')).default
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default
  puppeteer.use(StealthPlugin())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  let updated = 0
  const batchSize = 5
  
  for (let i = 0; i < Math.min(withUrl.length, 200); i++) {
    const t = withUrl[i]
    try {
      const page = await browser.newPage()
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
      
      let foundAvatar = null
      
      page.on('response', async (response) => {
        try {
          const ct = response.headers()['content-type'] || ''
          if (!ct.includes('json')) return
          const json = await response.json().catch(() => null)
          if (!json) return
          
          function find(obj, depth = 0) {
            if (depth > 5 || !obj || foundAvatar) return
            if (typeof obj === 'object' && !Array.isArray(obj)) {
              const avatar = obj.avatar || obj.avatarUrl || obj.leaderAvatar || ''
              if (isRealAvatar(avatar)) foundAvatar = avatar
              for (const val of Object.values(obj)) {
                if (typeof val === 'object') find(val, depth + 1)
              }
            }
            if (Array.isArray(obj)) {
              for (const item of obj) { if (typeof item === 'object') find(item, depth + 1) }
            }
          }
          find(json)
        } catch {}
      })

      await page.goto(t.profile_url, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
      await sleep(2000)
      
      if (foundAvatar && await setAvatar(t.id, foundAvatar)) {
        updated++
        if (updated % 10 === 0) console.log(`  [${updated}] ${t.handle}`)
      }
      
      await page.close()
      await sleep(1000 + Math.random() * 2000)
    } catch {}
    
    if (i > 0 && i % 20 === 0) console.log(`  Progress: ${i}/${withUrl.length}, updated: ${updated}`)
  }

  await browser.close()
  console.log(`  Bybit: ${updated}/${missing.length} updated`)
  return updated
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════
const HANDLERS = {
  coinex: backfillCoinEx,
  mexc: backfillMEXC,
  kucoin: backfillKuCoin,
  gateio: backfillGateIO,
  bybit: backfillBybitDetail,
  weex: () => backfillGenericBrowser('weex', 'https://www.weex.com/copy-trading'),
  blofin: () => backfillGenericBrowser('blofin', 'https://www.blofin.com/copy-trading'),
  toobit: () => backfillGenericBrowser('toobit', 'https://www.toobit.com/en-US/copy-trading'),
  bingx: () => backfillGenericBrowser('bingx', 'https://bingx.com/en/copy-trading/'),
  lbank: () => backfillGenericBrowser('lbank', 'https://www.lbank.com/copy-trading'),
}

async function main() {
  console.log(`\n🖼️  Avatar Backfill (Detail) ${DRY_RUN ? '(DRY RUN)' : ''}`)
  console.log(`Platform: ${SOURCE_FILTER || 'all'}, Limit: ${LIMIT}\n`)

  const sources = SOURCE_FILTER ? [SOURCE_FILTER] : Object.keys(HANDLERS)
  let totalUpdated = 0

  for (const source of sources) {
    const handler = HANDLERS[source]
    if (!handler) { console.log(`\n--- ${source}: no handler ---`); continue }
    try {
      totalUpdated += await handler()
    } catch (err) {
      console.error(`  ${source} error:`, err.message)
    }
  }

  // Final stats
  const { rows } = await pool.query(`
    SELECT count(*)::int as total, count(avatar_url)::int as has_avatar,
    (count(*) - count(avatar_url))::int as missing FROM trader_sources
  `)
  console.log('\n══════════════════════════════════')
  console.log(`Session updated: ${totalUpdated}`)
  console.log(`Overall: ${rows[0].has_avatar}/${rows[0].total} (${(rows[0].has_avatar/rows[0].total*100).toFixed(1)}%)`)
  console.log(`Missing: ${rows[0].missing}`)
  console.log('══════════════════════════════════')

  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })

#!/usr/bin/env node
/**
 * fetch-all-avatars.mjs — Comprehensive avatar fetcher using Playwright
 * 
 * Uses browser automation to intercept API responses from exchange websites,
 * extracting real avatar URLs for traders.
 *
 * Usage: node scripts/fetch-all-avatars.mjs [--source=platform] [--dry-run]
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── DB Helpers ──

async function getMissingTraders(source) {
  const all = []
  let from = 0
  while (true) {
    const { data } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', source)
      .is('avatar_url', null)
      .range(from, from + 999)
    if (!data?.length) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return all
}

async function updateAvatars(source, avatarMap) {
  const traders = await getMissingTraders(source)
  if (!traders.length) { console.log(`  ${source}: no missing avatars`); return 0 }
  
  let updated = 0
  for (const t of traders) {
    const avatar = avatarMap.get(t.source_trader_id) || avatarMap.get(t.handle)
    if (!avatar || avatar.includes('default') || avatar.includes('blockie') || avatar.includes('identicon')) continue
    if (DRY_RUN) { updated++; continue }
    const { error } = await supabase.from('trader_sources').update({ avatar_url: avatar }).eq('id', t.id)
    if (!error) updated++
  }
  console.log(`  ✅ ${source}: ${updated}/${traders.length} updated ${DRY_RUN ? '(DRY RUN)' : ''}`)
  return updated
}

// ── Playwright-based Fetcher ──

async function interceptAvatars(browser, config) {
  const { source, urls, scrollCount = 20, tabActions = [], waitMs = 3000 } = config
  console.log(`\n🔄 ${source}`)
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const avatarMap = new Map()
  
  // Intercept all JSON responses
  page.on('response', async (response) => {
    const url = response.url()
    // Skip static assets
    if (url.match(/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/)) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      extractAvatars(json, avatarMap, config.idFields || ['accountId', 'uid', 'traderId', 'uniqueCode', 'leaderId', 'userId', 'encryptedUid', 'portfolioId', 'traderUserId', 'leadConfigId', 'uniqueName'],
        config.avatarFields || ['avatar', 'avatarUrl', 'avatar_url', 'headUrl', 'headPic', 'imgUrl', 'portLink', 'userPhotoUrl', 'traderImg', 'headImg', 'photo', 'userPhoto', 'headPhoto', 'portraitLink'])
    } catch {}
  })
  
  for (const url of urls) {
    try {
      console.log(`  Loading ${url.slice(0, 80)}...`)
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
      
      // Close popups
      for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'I am not', 'Start', 'Agree', 'Continue', 'I understand']) {
        const btn = page.getByRole('button', { name: text })
        if (await btn.count() > 0) await btn.first().click().catch(() => {})
      }
      await sleep(waitMs)
      
      // Execute tab actions (click sort buttons, period selectors, etc.)
      for (const action of tabActions) {
        const el = page.getByText(action, { exact: true })
        if (await el.count() > 0) {
          await el.first().click().catch(() => {})
          await sleep(2000)
          // Scroll after each tab
          for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
            await sleep(1500)
          }
        }
      }
      
      // Scroll to load more
      for (let i = 0; i < scrollCount; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1500)
        // Click load more buttons
        for (const text of ['Load More', 'Show More', '更多', '加载更多', 'View More']) {
          const btn = page.getByText(new RegExp(text, 'i'))
          if (await btn.count() > 0) await btn.first().click().catch(() => {})
        }
        if (i % 5 === 4) console.log(`    Scroll ${i + 1}: ${avatarMap.size} avatars`)
      }
      console.log(`  After ${url.split('/').pop()}: ${avatarMap.size} avatars`)
    } catch (e) {
      console.log(`  Error loading ${url}: ${e.message}`)
    }
  }
  
  await context.close()
  return avatarMap
}

function extractAvatars(obj, map, idFields, avatarFields) {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    for (const item of obj) extractAvatars(item, map, idFields, avatarFields)
    return
  }
  
  // Check if this object has both an ID field and an avatar field
  let id = null
  let avatar = null
  for (const f of idFields) {
    if (obj[f]) { id = String(obj[f]); break }
  }
  for (const f of avatarFields) {
    if (obj[f] && typeof obj[f] === 'string' && obj[f].startsWith('http')) {
      avatar = obj[f]; break
    }
  }
  if (id && avatar) map.set(id, avatar)
  
  // Recurse into values
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') extractAvatars(val, map, idFields, avatarFields)
  }
}

// ── Platform Configs ──

const PLATFORMS = {
  binance_futures: {
    source: 'binance_futures',
    urls: [
      'https://www.binance.com/en/copy-trading',
      'https://www.binance.com/en/copy-trading/lead-details?portfolioId=test',
    ],
    tabActions: ['7D', '30D', '90D', 'ROI', 'PnL', 'Followers'],
    scrollCount: 30,
    idFields: ['portfolioId', 'encryptedUid'],
    avatarFields: ['userPhotoUrl', 'avatar', 'photoUrl'],
  },
  binance_spot: {
    source: 'binance_spot',
    urls: ['https://www.binance.com/en/copy-trading/spot'],
    tabActions: ['7D', '30D', '90D'],
    scrollCount: 20,
    idFields: ['portfolioId', 'encryptedUid'],
    avatarFields: ['userPhotoUrl', 'avatar', 'photoUrl'],
  },
  bybit: {
    source: 'bybit',
    urls: [
      'https://www.bybit.com/copyTrade',
      'https://www.bybit.com/en/copy-trading/',
    ],
    tabActions: ['7 Days', '30 Days', '90 Days', 'PnL', 'ROI', 'Followers'],
    scrollCount: 25,
    idFields: ['leaderMark', 'leaderId', 'uid'],
    avatarFields: ['avatar', 'avatarUrl', 'headUrl'],
  },
  bitget_futures: {
    source: 'bitget_futures',
    urls: ['https://www.bitget.com/copy-trading'],
    tabActions: ['7 Days', '30 Days', '90 Days', 'ROI', 'Total Profit'],
    scrollCount: 25,
    idFields: ['traderId', 'traderUid'],
    avatarFields: ['headUrl', 'avatar', 'traderImg'],
  },
  bitget_spot: {
    source: 'bitget_spot',
    urls: ['https://www.bitget.com/copy-trading/spot'],
    tabActions: ['7 Days', '30 Days', '90 Days'],
    scrollCount: 20,
    idFields: ['traderId', 'traderUid'],
    avatarFields: ['headUrl', 'avatar', 'traderImg'],
  },
  xt: {
    source: 'xt',
    urls: ['https://www.xt.com/en/copy-trading/futures'],
    tabActions: ['7 Days', '30 Days', '90 Days', 'ROI', 'PnL', 'Win Rate', 'Followers'],
    scrollCount: 30,
    idFields: ['accountId'],
    avatarFields: ['avatar'],
  },
  kucoin: {
    source: 'kucoin',
    urls: ['https://www.kucoin.com/copy-trading'],
    tabActions: ['7 Days', '30 Days', '90 Days'],
    scrollCount: 20,
    idFields: ['leadConfigId', 'leaderId', 'uid'],
    avatarFields: ['avatarUrl', 'avatar'],
  },
  coinex: {
    source: 'coinex',
    urls: ['https://www.coinex.com/copy-trading'],
    tabActions: ['7D', '30D', '90D'],
    scrollCount: 20,
    idFields: ['traderId', 'uid', 'id'],
    avatarFields: ['avatar', 'avatar_url'],
  },
  mexc: {
    source: 'mexc',
    urls: [
      'https://futures.mexc.com/copy-trade',
      'https://www.mexc.com/copy-trade',
    ],
    tabActions: ['7 Days', '30 Days', '90 Days', 'ROI', 'Profit'],
    scrollCount: 30,
    idFields: ['traderId', 'uid', 'userId'],
    avatarFields: ['avatar', 'avatarUrl', 'headImg'],
  },
  weex: {
    source: 'weex',
    urls: ['https://www.weex.com/copy-trading'],
    tabActions: ['7 Days', '30 Days'],
    scrollCount: 15,
    idFields: ['traderUserId', 'traderId', 'uid'],
    avatarFields: ['headPic', 'avatar', 'headUrl'],
  },
  bingx: {
    source: 'bingx',
    urls: ['https://bingx.com/en/copy-trading/'],
    tabActions: ['7D', '30D', '90D'],
    scrollCount: 15,
    idFields: ['uniqueId', 'uid', 'traderId'],
    avatarFields: ['headUrl', 'avatar', 'avatarUrl'],
  },
  lbank: {
    source: 'lbank',
    urls: ['https://www.lbank.com/copy-trading'],
    tabActions: [],
    scrollCount: 10,
    idFields: ['traderId', 'uid', 'userId'],
    avatarFields: ['avatar', 'headUrl', 'avatarUrl', 'photo'],
  },
  phemex: {
    source: 'phemex',
    urls: ['https://phemex.com/copy-trading'],
    tabActions: [],
    scrollCount: 10,
    idFields: ['traderId', 'uid'],
    avatarFields: ['avatar', 'headUrl', 'avatarUrl'],
  },
  blofin: {
    source: 'blofin',
    urls: ['https://blofin.com/copy-trading'],
    tabActions: [],
    scrollCount: 10,
    idFields: ['uniqueName', 'traderId'],
    avatarFields: ['avatar', 'avatarUrl', 'portraitLink'],
  },
}

// ── API-only Fetchers (no browser needed) ──

async function fetchOKXApi() {
  console.log('\n🔄 OKX Futures (API)')
  const avatarMap = new Map()
  
  for (let page = 1; page <= 50; page++) {
    try {
      const r = await fetch(`https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&page=${page}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      })
      const j = await r.json()
      const ranks = j?.data?.[0]?.ranks || []
      if (!ranks.length) break
      for (const t of ranks) {
        if (t.uniqueCode && t.portLink) avatarMap.set(t.uniqueCode, t.portLink)
      }
      if (ranks.length < 10) break
    } catch { break }
    await sleep(500)
  }
  
  console.log(`  OKX leaderboard: ${avatarMap.size} avatars`)
  return updateAvatars('okx_futures', avatarMap)
}

async function fetchHTXApi() {
  console.log('\n🔄 HTX Futures (API)')
  const avatarMap = new Map()
  
  for (let page = 1; page <= 30; page++) {
    try {
      const r = await fetch(`https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=50`, {
        signal: AbortSignal.timeout(10000),
      })
      const j = await r.json()
      const items = j?.data?.itemList || []
      if (!items.length) break
      for (const t of items) {
        if (t.imgUrl) {
          if (t.userSign) avatarMap.set(t.userSign, t.imgUrl)
          if (t.uid) avatarMap.set(String(t.uid), t.imgUrl)
          if (t.nickName) avatarMap.set(t.nickName, t.imgUrl)
        }
      }
      if (items.length < 50) break
    } catch { break }
    await sleep(500)
  }
  
  console.log(`  HTX leaderboard: ${avatarMap.size} avatars`)
  return updateAvatars('htx_futures', avatarMap)
}

// ── Main ──

async function main() {
  console.log(`\n🖼️ Comprehensive Avatar Fetch ${DRY_RUN ? '(DRY RUN)' : ''}`)
  console.log(`Platform: ${SOURCE_FILTER || 'all'}\n`)
  
  let totalUpdated = 0
  
  // API-only platforms first
  if (!SOURCE_FILTER || SOURCE_FILTER === 'okx_futures') {
    totalUpdated += await fetchOKXApi()
  }
  if (!SOURCE_FILTER || SOURCE_FILTER === 'htx_futures') {
    totalUpdated += await fetchHTXApi()
  }
  
  // Playwright-based platforms
  const platformsToFetch = SOURCE_FILTER 
    ? (PLATFORMS[SOURCE_FILTER] ? [PLATFORMS[SOURCE_FILTER]] : [])
    : Object.values(PLATFORMS)
  
  if (platformsToFetch.length > 0) {
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    })
    
    for (const config of platformsToFetch) {
      try {
        const avatarMap = await interceptAvatars(browser, config)
        totalUpdated += await updateAvatars(config.source, avatarMap)
      } catch (e) {
        console.log(`  ❌ ${config.source}: ${e.message}`)
      }
    }
    
    await browser.close()
  }
  
  console.log(`\n========================================`)
  console.log(`Total updated: ${totalUpdated}`)
  console.log(`========================================\n`)
  
  // Show remaining stats
  const counts = {}
  let from = 0
  while (true) {
    const { data } = await supabase.from('trader_sources').select('source').is('avatar_url', null).range(from, from + 999)
    if (!data?.length) break
    for (const r of data) counts[r.source] = (counts[r.source] || 0) + 1
    from += 1000
    if (data.length < 1000) break
  }
  console.log('Remaining missing:')
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`)
  }
}

main().catch(console.error)

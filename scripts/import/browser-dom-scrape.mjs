#!/usr/bin/env node
/**
 * DOM scraping approach - CF 过了之后直接从 DOM 提取交易员数据
 * 通过 API 拦截 + DOM 提取双管齐下
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function calcScore(roi, pnl, dd, wr) {
  if (roi == null) return null
  let rs = Math.min(70, roi > 0 ? Math.log(1 + roi / 100) * 25 : Math.max(-70, roi / 100 * 50))
  let ds = dd != null ? Math.max(0, 15 * (1 - dd / 100)) : 7.5
  let ss = wr != null ? Math.min(15, wr / 100 * 15) : 7.5
  return clip(Math.round((rs + ds + ss) * 10) / 10, 0, 100)
}

async function save(source, traders, seasonId, marketType = 'futures') {
  const now = new Date().toISOString()
  if (!traders.length) return 0
  const srcData = traders.map(t => ({
    source, source_trader_id: t.id, handle: t.name || t.id,
    avatar_url: t.avatar || null, profile_url: t.profileUrl || null,
    market_type: marketType, is_active: true,
  }))
  await supabase.from('trader_sources').upsert(srcData, { onConflict: 'source,source_trader_id' })
  
  const snapData = traders.map((t, i) => ({
    source, source_trader_id: t.id, season_id: seasonId, rank: i + 1,
    roi: t.roi, pnl: t.pnl, win_rate: t.wr, max_drawdown: t.dd,
    trades_count: t.trades, followers: t.followers,
    arena_score: calcScore(t.roi, t.pnl, t.dd, t.wr),
    captured_at: now,
  }))
  
  let saved = 0
  for (let i = 0; i < snapData.length; i += 50) {
    const chunk = snapData.slice(i, i + 50)
    const { error } = await supabase.from('trader_snapshots').upsert(chunk, { onConflict: 'source,source_trader_id,season_id' })
    if (error) {
      for (const s of chunk) {
        const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
        if (!e) saved++
      }
    } else saved += chunk.length
  }
  return saved
}

async function launchBrowser() {
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) })
  await sleep(500)
  
  return chromium.launch({
    headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=800,600', '--window-position=9999,9999', '--disable-gpu', '--disable-extensions'],
  })
}

async function waitCF(page, maxWait = 40) {
  for (let i = 0; i < maxWait; i++) {
    const t = await page.title()
    if (!t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 2) {
      return true
    }
    await sleep(1000)
  }
  return false
}

// ===================== BITGET =====================
async function scrapeBitget() {
  console.log('\n📊 Bitget Futures')
  const browser = await launchBrowser()
  const apiTraders = []
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4}', r => r.abort())
    
    // Intercept ALL JSON API responses
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const d = await res.json()
        // Look for any array of objects with traderId
        const findTraders = (obj, depth = 0) => {
          if (depth > 3 || !obj) return
          if (Array.isArray(obj)) {
            const hasTraders = obj.some(it => it.traderId || it.nickName)
            if (hasTraders && obj.length > 0) {
              for (const it of obj) {
                if (it.traderId) apiTraders.push({
                  id: it.traderId, name: it.nickName || it.nickname,
                  avatar: it.headUrl || it.avatar,
                  profileUrl: `https://www.bitget.com/copy-trading/trader/${it.traderId}/futures`,
                  roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
                  pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
                  wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                  dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
                  trades: it.totalOrderNum ? parseInt(it.totalOrderNum) : null,
                  followers: it.currentCopyCount ? parseInt(it.currentCopyCount) : null,
                })
              }
              process.stdout.write(`\r  API拦截: ${apiTraders.length}`)
            }
          }
          if (typeof obj === 'object') {
            for (const v of Object.values(obj)) findTraders(v, depth + 1)
          }
        }
        findTraders(d)
      } catch {}
    })
    
    await page.goto('https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', { timeout: 40000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    if (!await waitCF(page)) { console.log('  CF ❌'); return }
    console.log('  CF ✅')
    
    await sleep(6000)
    
    // Also try DOM scraping - extract from page
    const domTraders = await page.evaluate(() => {
      const results = []
      // Try to find trader cards / rows
      const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="row"]')
      for (const card of cards) {
        const text = card.textContent || ''
        // Look for ROI pattern like "+123.45%" or "-12.3%"
        const roiMatch = text.match(/([+-]?\d+\.?\d*)\s*%/)
        const nameEl = card.querySelector('a, [class*="name"], [class*="nick"]')
        const linkEl = card.querySelector('a[href*="trader"]')
        if (roiMatch && nameEl) {
          const href = linkEl?.href || ''
          const idMatch = href.match(/trader\/(\w+)/)
          if (idMatch) {
            results.push({
              id: idMatch[1],
              name: nameEl.textContent?.trim(),
              roi: parseFloat(roiMatch[1]),
              profileUrl: href,
            })
          }
        }
      }
      return results
    })
    
    if (domTraders.length) {
      console.log(`\n  DOM提取: ${domTraders.length}`)
    }
    
    // Scroll and paginate
    for (let i = 0; i < 10; i++) {
      try { await page.evaluate(() => document.body && window.scrollTo(0, document.body.scrollHeight)) } catch {}
      await sleep(2000)
      try {
        const next = page.locator('button:has-text("Next"), [class*="next"]:not([disabled])')
        if (await next.count()) { await next.first().click(); await sleep(3000) }
      } catch {}
    }
    
    await ctx.close()
    
    // Merge API + DOM results
    const all = [...apiTraders, ...domTraders]
    const unique = [...new Map(all.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    
    if (unique.length) {
      const saved = await save('bitget_futures', unique, '30D')
      console.log(`  ✅ ${saved} 条已保存`)
    }
  } finally {
    await browser.close()
  }
}

// ===================== MEXC =====================
async function scrapeMEXC() {
  console.log('\n📊 MEXC')
  const browser = await launchBrowser()
  const apiTraders = []
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4}', r => r.abort())
    
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const d = await res.json()
        const findTraders = (obj, depth = 0) => {
          if (depth > 3 || !obj) return
          if (Array.isArray(obj) && obj.length > 2) {
            const hasTraders = obj.some(it => it.traderUid || it.uid || it.traderId || it.nickName)
            if (hasTraders) {
              for (const it of obj) {
                const uid = String(it.traderUid || it.uid || it.traderId || it.id || '')
                if (!uid) continue
                apiTraders.push({
                  id: uid, name: it.nickName || it.nickname || it.name,
                  avatar: it.avatarUrl || it.avatar,
                  roi: it.roi != null ? parseFloat(it.roi) : (it.roiRate != null ? parseFloat(it.roiRate) * 100 : null),
                  pnl: it.profit != null ? parseFloat(it.profit) : null,
                  wr: it.winRate != null ? (parseFloat(it.winRate) > 1 ? parseFloat(it.winRate) : parseFloat(it.winRate) * 100) : null,
                  followers: it.copyCount || it.followerCount,
                })
              }
              process.stdout.write(`\r  API拦截: ${apiTraders.length}`)
            }
          }
          if (typeof obj === 'object') {
            for (const v of Object.values(obj)) findTraders(v, depth + 1)
          }
        }
        findTraders(d)
      } catch {}
    })
    
    await page.goto('https://www.mexc.com/futures/copyTrade/home', { timeout: 40000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    if (!await waitCF(page)) { console.log('  CF ❌'); return }
    console.log('  CF ✅')
    
    await sleep(6000)
    
    // Scroll and paginate
    for (let i = 0; i < 15; i++) {
      try { await page.evaluate(() => document.body && window.scrollTo(0, document.body.scrollHeight)) } catch {}
      await sleep(2000)
    }
    
    const unique = [...new Map(apiTraders.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    
    if (unique.length) {
      const saved = await save('mexc', unique, '30D')
      console.log(`  ✅ ${saved} 条已保存`)
    }
    
    await ctx.close()
  } finally {
    await browser.close()
  }
}

// ===================== KuCoin =====================
async function scrapeKuCoin() {
  console.log('\n📊 KuCoin')
  const browser = await launchBrowser()
  const apiTraders = []
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4}', r => r.abort())
    
    // Intercept ALL json responses
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const url = res.url()
        const d = await res.json()
        const findTraders = (obj, depth = 0) => {
          if (depth > 3 || !obj) return
          if (Array.isArray(obj) && obj.length > 2) {
            const hasTraders = obj.some(it => it.leaderId || it.uid || it.traderUid)
            if (hasTraders) {
              for (const it of obj) {
                const uid = it.leaderId || it.uid || it.traderUid || it.traderId
                if (!uid) continue
                apiTraders.push({
                  id: uid, name: it.nickName || it.nickname,
                  avatar: it.avatar,
                  profileUrl: `https://www.kucoin.com/copy-trading/leader/${uid}`,
                  roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
                  pnl: it.pnl != null ? parseFloat(it.pnl) : null,
                  wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                  dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
                  followers: it.followerCount,
                })
              }
              process.stdout.write(`\r  API拦截: ${apiTraders.length}`)
            }
          }
          if (typeof obj === 'object') {
            for (const v of Object.values(obj)) findTraders(v, depth + 1)
          }
        }
        findTraders(d)
      } catch {}
    })
    
    // Try multiple KuCoin URLs
    for (const url of [
      'https://www.kucoin.com/copy-trading/leaderboard',
      'https://www.kucoin.com/copy-trading',
    ]) {
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {})
      if (!await waitCF(page, 15)) continue
      console.log('  CF ✅')
      
      await sleep(6000)
      for (let i = 0; i < 10; i++) {
        try { await page.evaluate(() => document.body && window.scrollTo(0, document.body.scrollHeight)) } catch {}
        await sleep(2000)
      }
      
      if (apiTraders.length) break
    }
    
    const unique = [...new Map(apiTraders.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    
    if (unique.length) {
      const saved = await save('kucoin', unique, '30D')
      console.log(`  ✅ ${saved} 条已保存`)
    }
    
    await ctx.close()
  } finally {
    await browser.close()
  }
}

// ===================== CoinEx =====================
async function scrapeCoinEx() {
  console.log('\n📊 CoinEx')
  const browser = await launchBrowser()
  const apiTraders = []
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4}', r => r.abort())
    
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const d = await res.json()
        const findTraders = (obj, depth = 0) => {
          if (depth > 3 || !obj) return
          if (Array.isArray(obj) && obj.length > 2) {
            const hasTraders = obj.some(it => it.trader_id || it.uid || it.nickname)
            if (hasTraders) {
              for (const it of obj) {
                const uid = String(it.trader_id || it.uid || it.id || '')
                if (!uid) continue
                apiTraders.push({
                  id: uid, name: it.nickname || it.name,
                  avatar: it.avatar,
                  roi: it.roi != null ? parseFloat(it.roi) : null,
                  pnl: it.total_profit != null ? parseFloat(it.total_profit) : null,
                  wr: it.win_rate != null ? parseFloat(it.win_rate) * 100 : null,
                })
              }
              process.stdout.write(`\r  API拦截: ${apiTraders.length}`)
            }
          }
          if (typeof obj === 'object') {
            for (const v of Object.values(obj)) findTraders(v, depth + 1)
          }
        }
        findTraders(d)
      } catch {}
    })
    
    await page.goto('https://www.coinex.com/en/copy-trading/futures', { timeout: 40000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    if (!await waitCF(page)) { console.log('  CF ❌'); return }
    console.log('  CF ✅')
    
    await sleep(6000)
    for (let i = 0; i < 10; i++) {
      try { await page.evaluate(() => document.body && window.scrollTo(0, document.body.scrollHeight)) } catch {}
      await sleep(2000)
    }
    
    const unique = [...new Map(apiTraders.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    
    if (unique.length) {
      const saved = await save('coinex', unique, '30D')
      console.log(`  ✅ ${saved} 条已保存`)
    }
    
    await ctx.close()
  } finally {
    await browser.close()
  }
}

// ===================== BingX =====================
async function scrapeBingX() {
  console.log('\n📊 BingX')
  const browser = await launchBrowser()
  const apiTraders = []
  
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    const page = await ctx.newPage()
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4}', r => r.abort())
    
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const d = await res.json()
        const findTraders = (obj, depth = 0) => {
          if (depth > 3 || !obj) return
          if (Array.isArray(obj) && obj.length > 2) {
            const hasTraders = obj.some(it => it.traderUid || it.uid || it.copyTradeId)
            if (hasTraders) {
              for (const it of obj) {
                const uid = String(it.traderUid || it.uid || it.copyTradeId || '')
                if (!uid) continue
                apiTraders.push({
                  id: uid, name: it.nickName || it.nickname,
                  avatar: it.avatar,
                  roi: it.roi != null ? parseFloat(it.roi) : null,
                  pnl: it.profit != null ? parseFloat(it.profit) : null,
                  wr: it.winRate != null ? (parseFloat(it.winRate) > 1 ? parseFloat(it.winRate) : parseFloat(it.winRate) * 100) : null,
                  followers: it.copyCount || it.followerCount,
                })
              }
              process.stdout.write(`\r  API拦截: ${apiTraders.length}`)
            }
          }
          if (typeof obj === 'object') {
            for (const v of Object.values(obj)) findTraders(v, depth + 1)
          }
        }
        findTraders(d)
      } catch {}
    })
    
    await page.goto('https://bingx.com/en/copy-trading/', { timeout: 40000, waitUntil: 'domcontentloaded' }).catch(() => {})
    
    if (!await waitCF(page)) { console.log('  CF ❌'); return }
    console.log('  CF ✅')
    
    await sleep(6000)
    for (let i = 0; i < 10; i++) {
      try { await page.evaluate(() => document.body && window.scrollTo(0, document.body.scrollHeight)) } catch {}
      await sleep(2000)
    }
    
    const unique = [...new Map(apiTraders.filter(t => t.id).map(t => [t.id, t])).values()]
    console.log(`\n  总计: ${unique.length}`)
    
    if (unique.length) {
      const saved = await save('bingx', unique, '30D')
      console.log(`  ✅ ${saved} 条已保存`)
    }
    
    await ctx.close()
  } finally {
    await browser.close()
  }
}

// ===================== Main =====================
const platforms = { bitget: scrapeBitget, mexc: scrapeMEXC, kucoin: scrapeKuCoin, coinex: scrapeCoinEx, bingx: scrapeBingX }
const target = process.argv[2] || 'all'

async function main() {
  console.log(`🚀 Browser DOM Scrape [${target}]`)
  
  try {
    if (target === 'all') {
      for (const [name, fn] of Object.entries(platforms)) {
        try { await fn() } catch(e) { console.log(`  ❌ ${name}: ${e.message}`) }
        // Restore proxy between platforms
        await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) })
        await sleep(3000)
      }
    } else if (platforms[target]) {
      await platforms[target]()
    }
  } finally {
    await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) })
  }
  console.log('\n✅ 完成')
}

main().catch(e => { console.error(e); process.exit(1) })

/**
 * Stealth 浏览器抓取 - 使用 puppeteer-extra-plugin-stealth 绕过 Cloudflare
 * 一次只跑一个平台，严格限制内存
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteer.use(StealthPlugin())

// Load env
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
    trades_count: t.trades, follower_count: t.followers,
    arena_score: calcScore(t.roi, t.pnl, t.dd, t.wr),
    captured_at: now,
  }))
  const { error } = await supabase.from('trader_snapshots').upsert(snapData, { onConflict: 'source,source_trader_id,season_id' })
  if (error) {
    let ok = 0
    for (const s of snapData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
      if (!e) ok++
    }
    return ok
  }
  return traders.length
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
      '--disable-dev-shm-usage', '--no-first-run',
      '--disable-extensions', '--disable-background-networking',
      '--disable-default-apps', '--disable-sync',
      '--single-process',
    ],
  })
}

// Wait for CF challenge to pass
async function waitForCF(page, timeout = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const title = await page.title()
    if (!title.includes('moment') && !title.includes('Checking') && !title.includes('Verify')) return true
    await sleep(1000)
  }
  return false
}

// ============================================
// Binance Futures - intercept copy-trade API
// ============================================
async function scrapeBinance() {
  console.log('\n📊 Binance Futures...')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    
    const traders = []
    
    page.on('response', async res => {
      if (res.url().includes('query-list') || res.url().includes('copy-trade')) {
        try {
          const data = await res.json()
          const list = data?.data?.list
          if (Array.isArray(list)) {
            for (const it of list) {
              traders.push({
                id: it.leadPortfolioId || it.portfolioId || String(it.uid),
                name: it.nickname, avatar: it.userPhotoUrl,
                profileUrl: `https://www.binance.com/en/copy-trading/lead-details/${it.leadPortfolioId}`,
                roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
                pnl: it.pnl != null ? parseFloat(it.pnl) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
                trades: it.tradeCount, followers: it.copierNum,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })
    
    console.log('  打开页面...')
    await page.goto('https://www.binance.com/en/copy-trading', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
    await waitForCF(page)
    await sleep(5000)
    
    // Check if geo-blocked
    const content = await page.content()
    if (content.includes('restricted') || content.includes('not available') || content.includes('unavailable')) {
      console.log('\n  ⛔ 页面被地区限制')
      
      // Try API directly with cookies from page
      const cookies = await page.cookies()
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
      console.log('  尝试带 cookie 调 API...')
      
      for (let p = 1; p <= 25; p++) {
        try {
          const res = await page.evaluate(async (pageNum) => {
            const r = await fetch('/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pageNumber: pageNum, pageSize: 20, timeRange: '30D', dataType: 'ROI', favoriteOnly: false }),
            })
            return r.json()
          }, p)
          const list = res?.data?.list
          if (!list?.length) break
          for (const it of list) {
            traders.push({
              id: it.leadPortfolioId || it.portfolioId || String(it.uid),
              name: it.nickname, avatar: it.userPhotoUrl,
              roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
              pnl: it.pnl != null ? parseFloat(it.pnl) : null,
              wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
              dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
            })
          }
          process.stdout.write(`\r  API 页${p}: ${traders.length}`)
          await new Promise(r => setTimeout(r, 500))
        } catch { break }
      }
    } else {
      // Page loaded normally, scroll to load more
      for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(2000)
      }
    }
    
    console.log(`\n  总计: ${traders.length}`)
    const unique = [...new Map(traders.map(t => [t.id, t])).values()]
    if (unique.length) {
      const saved = await save('binance_futures', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条保存`)
    } else console.log('  ❌ 0 条')
    
    await page.close()
  } finally { await browser.close() }
}

// ============================================
// Bitget - intercept trader list API
// ============================================
async function scrapeBitget() {
  console.log('\n📊 Bitget Futures...')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    
    const traders = []
    
    page.on('response', async res => {
      const url = res.url()
      if (url.includes('queryCopyTrader') || url.includes('traderList') || 
          (url.includes('trader') && url.includes('list'))) {
        try {
          const data = await res.json()
          const list = data?.data?.list || data?.data?.traders || data?.data
          if (Array.isArray(list)) {
            for (const it of list) {
              if (!it.traderId) continue
              traders.push({
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
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })
    
    console.log('  打开页面...')
    await page.goto('https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    const cfPassed = await waitForCF(page, 25000)
    console.log(`  CF: ${cfPassed ? '通过' : '未通过'}`)
    await sleep(5000)
    
    // Try API calls from within page context 
    if (traders.length === 0) {
      console.log('  拦截无数据，尝试页内 API 调用...')
      for (let p = 1; p <= 25; p++) {
        try {
          const data = await page.evaluate(async (pageNo) => {
            const r = await fetch('/v1/trigger/trace/queryCopyTraderList', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pageNo, pageSize: 20, sort: 'ROI_DESC', range: '30d', languageType: 0 }),
            })
            return r.json()
          }, p)
          const list = data?.data?.list || data?.data
          if (!Array.isArray(list) || !list.length) break
          for (const it of list) {
            traders.push({
              id: it.traderId, name: it.nickName || it.nickname,
              avatar: it.headUrl,
              roi: it.yieldRate != null ? parseFloat(it.yieldRate) * 100 : null,
              pnl: it.totalProfit != null ? parseFloat(it.totalProfit) : null,
              wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
              dd: it.maxDrawDown != null ? parseFloat(it.maxDrawDown) * 100 : null,
            })
          }
          process.stdout.write(`\r  API 页${p}: ${traders.length}`)
          await new Promise(r => setTimeout(r, 400))
        } catch(e) { console.log(`  页${p}错误:`, e.message); break }
      }
    }
    
    // Scroll for more
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
    }
    
    console.log(`\n  总计: ${traders.length}`)
    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    if (unique.length) {
      const saved = await save('bitget_futures', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条保存`)
    } else console.log('  ❌ 0 条')
    
    await page.close()
  } finally { await browser.close() }
}

// ============================================
// MEXC
// ============================================
async function scrapeMEXC() {
  console.log('\n📊 MEXC...')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const traders = []
    
    page.on('response', async res => {
      const url = res.url()
      if (url.includes('copy') && (url.includes('trader') || url.includes('rank') || url.includes('leader'))) {
        try {
          const data = await res.json()
          const list = data?.data?.list || data?.data?.items || data?.data?.traders || data?.list
          if (Array.isArray(list)) {
            for (const it of list) {
              const id = it.traderUid || it.uid || it.traderId || String(it.id || '')
              if (!id) continue
              traders.push({
                id, name: it.nickName || it.nickname || it.name,
                avatar: it.avatarUrl || it.avatar,
                roi: it.roi != null ? parseFloat(it.roi) : (it.roiRate != null ? parseFloat(it.roiRate) * 100 : null),
                pnl: it.profit != null ? parseFloat(it.profit) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                followers: it.copyCount || it.followerCount,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })
    
    console.log('  打开页面...')
    await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await waitForCF(page)
    await sleep(5000)
    
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
    }
    
    console.log(`\n  总计: ${traders.length}`)
    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    if (unique.length) {
      const saved = await save('mexc', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条保存`)
    } else console.log('  ❌ 0 条')
    
    await page.close()
  } finally { await browser.close() }
}

// ============================================
// KuCoin
// ============================================
async function scrapeKuCoin() {
  console.log('\n📊 KuCoin...')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const traders = []
    
    page.on('response', async res => {
      const url = res.url()
      if (url.includes('leaderboard') || url.includes('leader-list') || url.includes('copy-trading')) {
        try {
          const data = await res.json()
          const list = data?.data?.items || data?.data?.list
          if (Array.isArray(list)) {
            for (const it of list) {
              const id = it.leaderId || it.uid || it.traderId
              if (!id) continue
              traders.push({
                id, name: it.nickName || it.nickname,
                avatar: it.avatar,
                profileUrl: `https://www.kucoin.com/copy-trading/leader/${id}`,
                roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
                pnl: it.pnl != null ? parseFloat(it.pnl) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
                dd: it.maxDrawdown != null ? parseFloat(it.maxDrawdown) * 100 : null,
                followers: it.followerCount,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })
    
    console.log('  打开页面...')
    await page.goto('https://www.kucoin.com/copy-trading/leaderboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await waitForCF(page)
    await sleep(5000)
    
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
      // Try clicking "load more" or next page
      try { await page.click('[class*="next"]', { timeout: 500 }) } catch {}
      try { await page.click('button:has-text("More")', { timeout: 500 }) } catch {}
    }
    
    console.log(`\n  总计: ${traders.length}`)
    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    if (unique.length) {
      const saved = await save('kucoin', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条保存`)
    } else console.log('  ❌ 0 条')
    
    await page.close()
  } finally { await browser.close() }
}

// ============================================
// CoinEx
// ============================================
async function scrapeCoinEx() {
  console.log('\n📊 CoinEx...')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const traders = []
    
    page.on('response', async res => {
      const url = res.url()
      if (url.includes('copytrading') || url.includes('copy-trading') || url.includes('trader')) {
        try {
          const data = await res.json()
          const list = data?.data?.list || data?.data?.traders || data?.data
          if (Array.isArray(list)) {
            for (const it of list) {
              const id = it.trader_id || it.uid || String(it.id || '')
              if (!id) continue
              traders.push({
                id, name: it.nickname || it.name,
                avatar: it.avatar,
                roi: it.roi != null ? parseFloat(it.roi) : null,
                pnl: it.total_profit != null ? parseFloat(it.total_profit) : null,
                wr: it.win_rate != null ? parseFloat(it.win_rate) * 100 : null,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })
    
    console.log('  打开页面...')
    await page.goto('https://www.coinex.com/en/copy-trading/futures', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await waitForCF(page)
    await sleep(5000)
    
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
    }
    
    console.log(`\n  总计: ${traders.length}`)
    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    if (unique.length) {
      const saved = await save('coinex', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条保存`)
    } else console.log('  ❌ 0 条')
    
    await page.close()
  } finally { await browser.close() }
}

// ============================================
// BingX
// ============================================
async function scrapeBingX() {
  console.log('\n📊 BingX...')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const traders = []
    
    page.on('response', async res => {
      const url = res.url()
      if (url.includes('copyTrade') || url.includes('trader') || url.includes('rank')) {
        try {
          const data = await res.json()
          const list = data?.data?.list || data?.data?.traders || data?.data?.records
          if (Array.isArray(list)) {
            for (const it of list) {
              const id = it.uid || it.traderId || it.userId || String(it.id || '')
              if (!id) continue
              traders.push({
                id, name: it.nickName || it.nickname,
                avatar: it.avatar,
                roi: it.roi != null ? parseFloat(it.roi) : null,
                pnl: it.totalPnl != null ? parseFloat(it.totalPnl) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })
    
    console.log('  打开页面...')
    await page.goto('https://bingx.com/en/copy-trading/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await waitForCF(page)
    await sleep(5000)
    
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
    }
    
    console.log(`\n  总计: ${traders.length}`)
    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    if (unique.length) {
      const saved = await save('bingx', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条保存`)
    } else console.log('  ❌ 0 条')
    
    await page.close()
  } finally { await browser.close() }
}

// ============================================
// Phemex
// ============================================
async function scrapePhemex() {
  console.log('\n📊 Phemex...')
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const traders = []
    
    page.on('response', async res => {
      const url = res.url()
      if (url.includes('copy') || url.includes('leader') || url.includes('rank')) {
        try {
          const data = await res.json()
          const list = data?.data?.rows || data?.data?.list || data?.data
          if (Array.isArray(list)) {
            for (const it of list) {
              const id = it.leaderId || it.uid || it.traderUid || String(it.id || '')
              if (!id) continue
              traders.push({
                id, name: it.nickName || it.nickname,
                avatar: it.avatar,
                roi: it.roi != null ? parseFloat(it.roi) * 100 : null,
                pnl: it.pnl != null ? parseFloat(it.pnl) : null,
                wr: it.winRate != null ? parseFloat(it.winRate) * 100 : null,
              })
            }
            process.stdout.write(`\r  拦截: ${traders.length}`)
          }
        } catch {}
      }
    })
    
    console.log('  打开页面...')
    await page.goto('https://phemex.com/copy-trading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await waitForCF(page)
    await sleep(5000)
    
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
    }
    
    console.log(`\n  总计: ${traders.length}`)
    const unique = [...new Map(traders.filter(t => t.id).map(t => [t.id, t])).values()]
    if (unique.length) {
      const saved = await save('phemex', unique, 'current_30d')
      console.log(`  ✅ ${saved} 条保存`)
    } else console.log('  ❌ 0 条')
    
    await page.close()
  } finally { await browser.close() }
}

// ============================================
async function main() {
  const target = process.argv[2] || 'all'
  console.log(`🚀 Stealth 浏览器抓取 [${target}]`)
  
  const platforms = {
    binance: scrapeBinance,
    bitget: scrapeBitget,
    mexc: scrapeMEXC,
    kucoin: scrapeKuCoin,
    coinex: scrapeCoinEx,
    bingx: scrapeBingX,
    phemex: scrapePhemex,
  }
  
  if (target === 'all') {
    for (const [name, fn] of Object.entries(platforms)) {
      try { await fn() } catch (e) { console.log(`  ❌ ${name}: ${e.message}`) }
    }
  } else if (platforms[target]) {
    await platforms[target]()
  } else {
    console.log(`可选: ${Object.keys(platforms).join(', ')}, all`)
  }
  console.log('\n✅ 完成!')
}

main().catch(console.error)

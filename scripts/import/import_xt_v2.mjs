#!/usr/bin/env node
/**
 * XT 改进版 — DOM scraping + UI navigation
 * 1. 点击 All Traders / 全部交易员
 * 2. 选择时间筛选
 * 3. 滚动加载更多
 * 4. 从 DOM 提取数据
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { execSync, spawn } from 'child_process'
import { chromium } from 'playwright'

const CHROME_PATH = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/snap/bin/chromium')

const envPath = '.env.local'
try { for (const l of readFileSync(envPath,'utf8').split('\n')) {
  const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]
}} catch{}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v,lo,hi) => Math.max(lo,Math.min(hi,v))
function cs(roi,p,d,w){if(roi==null)return null;return clip(Math.round((Math.min(70,roi>0?Math.log(1+roi/100)*25:Math.max(-70,roi/100*50))+(d!=null?Math.max(0,15*(1-d/100)):7.5)+(w!=null?Math.min(15,w/100*15):7.5))*10)/10,0,100)}

const PORT = 9337

async function launchChrome() {
  try { execSync('pkill -f "remote-debugging-port=9337"', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  spawn(CHROME_PATH, [
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/chrome-xt-v2',
    '--no-first-run','--disable-extensions','--disable-sync','--disable-gpu',
    '--window-size=1400,900','--window-position=50,50',
    '--proxy-server=http://127.0.0.1:7890',
    'about:blank',
  ], { stdio: 'ignore', detached: true }).unref()
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}
  }
  throw new Error('Chrome timeout')
}

async function main() {
  console.log('============================================================')
  console.log('XT Copy Trading - 改进版 DOM 抓取')
  console.log('============================================================')
  
  // Enable proxy
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }).catch(()=>{})
  await sleep(1000)
  
  await launchChrome()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0] || await browser.newContext()
  const page = await ctx.newPage()
  
  // Intercept API responses
  const apiTraders = new Map()
  page.on('response', async res => {
    try {
      const url = res.url()
      if (!url.includes('copy-trade') && !url.includes('trader') && !url.includes('leader')) return
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await res.json().catch(() => null)
      if (!json) return
      
      // Extract traders from various response shapes
      const extractTraders = (obj) => {
        if (!obj) return
        if (Array.isArray(obj)) {
          for (const item of obj) extractTraders(item)
          return
        }
        if (typeof obj === 'object') {
          // Check if this looks like a trader object
          if (obj.accountId || obj.traderUid || obj.traderId || obj.uid) {
            const id = String(obj.accountId || obj.traderUid || obj.traderId || obj.uid)
            if (id && !apiTraders.has(id)) {
              apiTraders.set(id, {
                id,
                name: obj.nickName || obj.nickname || obj.userName || '',
                avatar: obj.avatar || obj.avatarUrl || null,
                roi: obj.incomeRate != null ? parseFloat(obj.incomeRate) * 100 : (obj.roi || obj.roiRate ? parseFloat(obj.roi || obj.roiRate) : null),
                pnl: obj.income != null ? parseFloat(obj.income) : (obj.pnl ? parseFloat(obj.pnl) : null),
                wr: obj.winRate != null ? (parseFloat(obj.winRate) <= 1 ? parseFloat(obj.winRate) * 100 : parseFloat(obj.winRate)) : null,
                dd: obj.maxRetraction != null ? Math.abs(parseFloat(obj.maxRetraction)) * (Math.abs(parseFloat(obj.maxRetraction)) <= 1 ? 100 : 1) : null,
                followers: parseInt(obj.followerCount || obj.followers || 0) || null,
              })
            }
          }
          // Recurse into nested objects
          for (const key of ['result', 'data', 'list', 'items', 'traders', 'records']) {
            if (obj[key]) extractTraders(obj[key])
          }
        }
      }
      extractTraders(json)
      if (apiTraders.size > 0) process.stdout.write(`\r  API: ${apiTraders.size} traders`)
    } catch {}
  })
  
  // Go to copy trading page
  console.log('📱 访问页面...')
  await page.goto('https://www.xt.com/en/copy-trading/futures', { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(()=>{})
  
  // Wait for CF
  let cfOk = false
  for (let i = 0; i < 40; i++) {
    const t = await page.title().catch(() => '')
    if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
    await sleep(1500)
  }
  if (!cfOk) { console.log('❌ CF failed'); process.exit(1) }
  console.log('✅ CF passed')
  
  await sleep(5000)
  
  // Try to find and click "All Traders" or similar tab
  console.log('🔍 寻找 All Traders 标签...')
  const allTradersSelectors = [
    'text=All Traders', 'text=全部交易员', 'text=All', 'text=全部',
    '[class*="all"]', '[class*="trader-list"]', '[data-tab="all"]',
    'a[href*="all"]', 'button:has-text("All")', 'div:has-text("All Traders"):visible'
  ]
  for (const sel of allTradersSelectors) {
    try {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click()
        console.log(`  ✓ 点击: ${sel}`)
        await sleep(3000)
        break
      }
    } catch {}
  }
  
  // Try clicking time period filters (30D, 90D)
  console.log('🔍 寻找时间筛选...')
  const timeSelectors = ['text=30D', 'text=30天', 'text=30 Days', 'text=Monthly', 'text=月']
  for (const sel of timeSelectors) {
    try {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click()
        console.log(`  ✓ 选择: ${sel}`)
        await sleep(3000)
        break
      }
    } catch {}
  }
  
  // Scroll to load more
  console.log('📜 滚动加载更多...')
  let prevCount = 0
  let stableCount = 0
  for (let i = 0; i < 20 && stableCount < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
    
    // Also try clicking "Load More" button
    try {
      const loadMore = page.locator('text=Load More, text=加载更多, text=More, button:has-text("more")').first()
      if (await loadMore.isVisible({ timeout: 500 })) {
        await loadMore.click()
        await sleep(2000)
      }
    } catch {}
    
    // Also try clicking "Next" for pagination
    try {
      const next = page.locator('button:has-text("Next"), [class*="next"]:not([disabled]), .ant-pagination-next:not(.ant-pagination-disabled)').first()
      if (await next.isVisible({ timeout: 500 })) {
        await next.click()
        await sleep(2000)
      }
    } catch {}
    
    if (apiTraders.size === prevCount) stableCount++
    else { stableCount = 0; prevCount = apiTraders.size }
    process.stdout.write(`\r  滚动 ${i+1}: API ${apiTraders.size} traders`)
  }
  console.log()
  
  // DOM scraping as backup
  console.log('🔍 DOM 提取...')
  const domTraders = await page.evaluate(() => {
    const traders = []
    // Try various card selectors
    const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="row"]')
    for (const card of cards) {
      const text = card.textContent || ''
      // Look for ROI pattern
      const roiMatch = text.match(/([+-]?\d+\.?\d*)\s*%/)
      if (!roiMatch) continue
      
      // Try to find trader name
      const nameEl = card.querySelector('[class*="name"], [class*="title"], h3, h4, span[class*="nick"]')
      const name = nameEl?.textContent?.trim() || ''
      if (!name || name.length > 50) continue
      
      // Try to find ID from link
      const link = card.querySelector('a[href*="detail"], a[href*="trader"]')
      const href = link?.getAttribute('href') || ''
      const idMatch = href.match(/(\d+)/)
      const id = idMatch ? idMatch[1] : name.replace(/\s+/g, '_')
      
      // Extract metrics
      const roi = parseFloat(roiMatch[1])
      const wrMatch = text.match(/Win\s*Rate[:\s]*(\d+\.?\d*)%/i) || text.match(/胜率[:\s]*(\d+\.?\d*)%/)
      const ddMatch = text.match(/Drawdown[:\s]*(\d+\.?\d*)%/i) || text.match(/回撤[:\s]*(\d+\.?\d*)%/)
      
      traders.push({
        id, name, roi,
        wr: wrMatch ? parseFloat(wrMatch[1]) : null,
        dd: ddMatch ? parseFloat(ddMatch[1]) : null,
      })
    }
    return traders
  })
  console.log(`  DOM: ${domTraders.length} traders`)
  
  // Merge API and DOM data
  const allTraders = new Map(apiTraders)
  for (const t of domTraders) {
    if (!allTraders.has(t.id)) allTraders.set(t.id, t)
  }
  
  console.log(`\n📊 总计: ${allTraders.size} unique traders`)
  
  // Save to database
  if (allTraders.size > 0) {
    const all = [...allTraders.values()]
    const now = new Date().toISOString()
    let saved = 0
    
    // Save sources
    for (let i = 0; i < all.length; i += 50) {
      try {
        await sb.from('trader_sources').upsert(all.slice(i, i + 50).map(t => ({
          source: 'xt', source_trader_id: t.id, handle: t.name || t.id,
          avatar_url: t.avatar, market_type: 'futures', is_active: true,
          profile_url: `https://www.xt.com/en/copy-trading/futures/detail/${t.id}`,
        })), { onConflict: 'source,source_trader_id' })
      } catch (e) { console.log('src err:', e.message) }
    }
    
    // Save snapshots
    for (let i = 0; i < all.length; i += 30) {
      const { error } = await sb.from('trader_snapshots').upsert(all.slice(i, i + 30).map((t, j) => ({
        source: 'xt', source_trader_id: t.id, season_id: '30D',
        rank: i + j + 1, roi: t.roi, pnl: t.pnl, win_rate: t.wr,
        max_drawdown: t.dd, trades_count: t.trades || null,
        arena_score: cs(t.roi, t.pnl, t.dd, t.wr), captured_at: now
      })), { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += Math.min(30, all.length - i)
    }
    
    console.log(`✅ ${saved} saved`)
  } else {
    console.log('❌ No data')
  }
  
  // Cleanup
  await page.close().catch(() => {})
  browser.close().catch(() => {})
  try { execSync('pkill -f "remote-debugging-port=9337"', { stdio: 'ignore' }) } catch {}
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }).catch(() => {})
}

main().then(() => process.exit(0)).catch(e => { console.log('❌', e.message); process.exit(1) })

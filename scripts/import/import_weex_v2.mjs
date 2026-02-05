#!/usr/bin/env node
/**
 * Weex 改进版 - 点击 "全部交易专家" 获取完整列表
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

try { for (const l of readFileSync('.env.local','utf8').split('\n')) {
  const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]
}} catch{}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v,lo,hi) => Math.max(lo,Math.min(hi,v))
function cs(roi,p,d,w){if(roi==null)return null;return clip(Math.round((Math.min(70,roi>0?Math.log(1+roi/100)*25:Math.max(-70,roi/100*50))+(d!=null?Math.max(0,15*(1-d/100)):7.5)+(w!=null?Math.min(15,w/100*15):7.5))*10)/10,0,100)}

async function main() {
  console.log('============================================================')
  console.log('Weex Copy Trading - 改进版')
  console.log('目标: 点击 "全部交易专家" 获取完整列表')
  console.log('============================================================')
  
  // Enable proxy
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'global' }) }).catch(()=>{})
  await sleep(1000)
  
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--proxy-server=http://127.0.0.1:7890',
      '--window-size=1400,900',
      '--disable-gpu',
      '--no-sandbox',
    ]
  })
  
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900 })
  
  // Intercept API responses
  const apiTraders = new Map()
  page.on('response', async res => {
    try {
      const url = res.url()
      if (!url.includes('trader') && !url.includes('copy') && !url.includes('expert') && !url.includes('leader')) return
      const ct = res.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await res.json().catch(() => null)
      if (!json) return
      
      const extract = (obj) => {
        if (!obj) return
        if (Array.isArray(obj)) { obj.forEach(extract); return }
        if (typeof obj === 'object') {
          // Check for trader-like objects
          const id = obj.traderUid || obj.traderId || obj.uid || obj.id
          if (id && (obj.roi !== undefined || obj.profit !== undefined || obj.returnRate !== undefined)) {
            const traderId = String(id)
            if (!apiTraders.has(traderId)) {
              apiTraders.set(traderId, {
                id: traderId,
                name: obj.nickName || obj.nickname || obj.userName || obj.name || '',
                avatar: obj.avatar || obj.avatarUrl || null,
                roi: obj.roi != null ? parseFloat(obj.roi) : (obj.returnRate ? parseFloat(obj.returnRate) * 100 : null),
                pnl: obj.profit != null ? parseFloat(obj.profit) : (obj.pnl ? parseFloat(obj.pnl) : null),
                wr: obj.winRate != null ? parseFloat(obj.winRate) : null,
                dd: obj.maxDrawdown != null ? Math.abs(parseFloat(obj.maxDrawdown)) : null,
                followers: parseInt(obj.followerCount || obj.followers || 0) || null,
              })
            }
          }
          // Recurse
          for (const key of ['data', 'list', 'items', 'traders', 'result', 'records']) {
            if (obj[key]) extract(obj[key])
          }
        }
      }
      extract(json)
      if (apiTraders.size > 0) process.stdout.write(`\r  API: ${apiTraders.size} traders`)
    } catch {}
  })
  
  console.log('📱 访问页面...')
  await page.goto('https://www.weex.com/zh-CN/copy-trading', { waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{})
  await sleep(5000)
  
  // Click "全部交易专家" (All elite traders)
  console.log('\n🔍 点击 "全部交易专家"...')
  const allTradersSelectors = [
    'text/全部交易专家',
    'text/All elite traders',
    'text/全部',
    'text/All',
    '[class*="all"]',
    'button:has-text("全部")',
    'div:has-text("全部交易专家")',
    'a:has-text("全部")',
  ]
  
  for (const sel of allTradersSelectors) {
    try {
      if (sel.startsWith('text/')) {
        const text = sel.replace('text/', '')
        const elements = await page.$x(`//*[contains(text(), '${text}')]`)
        if (elements.length > 0) {
          await elements[0].click()
          console.log(`  ✓ 点击: ${text}`)
          await sleep(3000)
          break
        }
      } else {
        const el = await page.$(sel)
        if (el) {
          await el.click()
          console.log(`  ✓ 点击: ${sel}`)
          await sleep(3000)
          break
        }
      }
    } catch {}
  }
  
  // Try time period selection (3周/30D)
  console.log('🔍 选择时间周期...')
  const timeSelectors = ['text/3周', 'text/30D', 'text/30天', 'text/Monthly']
  for (const sel of timeSelectors) {
    try {
      const text = sel.replace('text/', '')
      const elements = await page.$x(`//*[contains(text(), '${text}')]`)
      if (elements.length > 0) {
        await elements[0].click()
        console.log(`  ✓ 选择: ${text}`)
        await sleep(3000)
        break
      }
    } catch {}
  }
  
  // Scroll to load more
  console.log('📜 滚动加载...')
  let prevCount = 0
  let stableCount = 0
  for (let i = 0; i < 30 && stableCount < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
    
    // Try clicking "Load More" or pagination
    try {
      const loadMore = await page.$x("//*[contains(text(), '加载更多') or contains(text(), 'Load More') or contains(text(), '更多')]")
      if (loadMore.length > 0) {
        await loadMore[0].click()
        await sleep(2000)
      }
    } catch {}
    
    if (apiTraders.size === prevCount) stableCount++
    else { stableCount = 0; prevCount = apiTraders.size }
    process.stdout.write(`\r  滚动 ${i+1}: ${apiTraders.size} traders`)
  }
  
  // DOM scraping backup
  console.log('\n🔍 DOM 提取...')
  const domTraders = await page.evaluate(() => {
    const traders = []
    const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"]')
    for (const card of cards) {
      const text = card.textContent || ''
      const roiMatch = text.match(/([+-]?\d+\.?\d*)\s*%/)
      if (!roiMatch) continue
      
      const nameEl = card.querySelector('[class*="name"], [class*="nick"], h3, h4')
      const name = nameEl?.textContent?.trim() || ''
      if (!name || name.length > 50) continue
      
      const link = card.querySelector('a[href*="trader"], a[href*="detail"]')
      const href = link?.getAttribute('href') || ''
      const idMatch = href.match(/(\d+)/)
      
      traders.push({
        id: idMatch ? idMatch[1] : name.replace(/\s+/g, '_'),
        name,
        roi: parseFloat(roiMatch[1]),
      })
    }
    return traders
  })
  console.log(`  DOM: ${domTraders.length} traders`)
  
  // Merge
  for (const t of domTraders) {
    if (!apiTraders.has(t.id)) apiTraders.set(t.id, t)
  }
  
  console.log(`\n📊 总计: ${apiTraders.size} unique traders`)
  
  // Save
  if (apiTraders.size > 0) {
    const all = [...apiTraders.values()]
    const now = new Date().toISOString()
    let saved = 0
    
    for (let i = 0; i < all.length; i += 50) {
      try {
        await sb.from('trader_sources').upsert(all.slice(i, i + 50).map(t => ({
          source: 'weex', source_trader_id: t.id, handle: t.name || t.id,
          avatar_url: t.avatar, market_type: 'futures', is_active: true,
        })), { onConflict: 'source,source_trader_id' })
      } catch {}
    }
    
    for (let i = 0; i < all.length; i += 30) {
      const { error } = await sb.from('trader_snapshots').upsert(all.slice(i, i + 30).map((t, j) => ({
        source: 'weex', source_trader_id: t.id, season_id: '30D',
        rank: i + j + 1, roi: t.roi, pnl: t.pnl, win_rate: t.wr,
        max_drawdown: t.dd, arena_score: cs(t.roi, t.pnl, t.dd, t.wr), captured_at: now
      })), { onConflict: 'source,source_trader_id,season_id' })
      if (!error) saved += Math.min(30, all.length - i)
    }
    
    console.log(`✅ ${saved} saved`)
  } else {
    console.log('❌ No data')
  }
  
  await browser.close()
  await fetch('http://127.0.0.1:9090/configs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct' }) }).catch(()=>{})
}

main().then(() => process.exit(0)).catch(e => { console.log('❌', e.message); process.exit(1) })

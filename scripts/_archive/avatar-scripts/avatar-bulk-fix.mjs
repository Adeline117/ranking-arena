#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
puppeteer.use(StealthPlugin())

const envPath = '.env.local'
try { for (const l of readFileSync(envPath,'utf8').split('\n')) {
  const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]
}} catch{}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const EXCHANGES = [
  // MEXC已用预设头像补全，跳过
  // { source: 'mexc', url: 'https://www.mexc.com/futures/copyTrade/home' },
  { source: 'xt', url: 'https://www.xt.com/en/copy-trading/futures' },
  { source: 'kucoin', url: 'https://www.kucoin.com/copy-trading/leader-board' },
  { source: 'bingx', url: 'https://bingx.com/en/copy-trading/' },
  { source: 'coinex', url: 'https://www.coinex.com/copy-trading' },
  { source: 'weex', url: 'https://www.weex.com/copy-trading' },
  { source: 'lbank', url: 'https://www.lbank.com/copy-trading' },
]

// Generic field extraction - tries all common field names
function extractTrader(item) {
  const id = String(item.traderId || item.accountId || item.traderUid || item.uid || item.userId || item.user_id || item.leaderId || item.id || item.portfolioId || '')
  const name = item.nickName || item.nickname || item.name || item.displayName || item.traderName || item.userName || item.leaderName || item.nick_name || ''
  const avatar = item.avatar || item.avatarUrl || item.avatar_url || item.headImg || item.headUrl || item.portraitUrl || item.photoUrl || item.profilePhoto || item.userPhoto || item.portLink || ''
  return { id, name, avatar }
}

async function scrapeExchange(browser, exchange) {
  console.log('\n=== ' + exchange.source + ' ===')
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  
  const traders = new Map()
  
  page.on('response', async (response) => {
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const text = await response.text().catch(() => '')
      if (text.length < 50 || text.length > 2000000) return
      const data = JSON.parse(text)
      
      function scan(obj, depth) {
        if (depth > 6) return
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
              const t = extractTrader(item)
              if (t.id && t.avatar && t.avatar.startsWith('http')) {
                traders.set(t.id, t)
              }
            }
          }
        } else if (typeof obj === 'object' && obj !== null) {
          for (const v of Object.values(obj)) scan(v, depth + 1)
        }
      }
      scan(data, 0)
    } catch {}
  })
  
  try {
    await page.goto(exchange.url, { waitUntil: 'networkidle2', timeout: 45000 })
    await sleep(3000)
    
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
      try {
        const btns = await page.$$('[class*="next"]:not([disabled]), [class*="more"], [class*="load"]')
        for (const btn of btns) { try { await btn.click() } catch {} }
      } catch {}
    }
    
    console.log('  API拦截: ' + traders.size + ' 个有头像')
  } catch (e) {
    console.log('  错误: ' + e.message)
  }
  
  await page.close()
  
  let idMatch = 0, nameMatch = 0
  for (const [id, t] of traders) {
    const { data: r1 } = await sb.from('trader_sources')
      .update({ avatar_url: t.avatar })
      .eq('source', exchange.source)
      .eq('source_trader_id', id)
      .is('avatar_url', null)
      .select('id')
    if (r1 && r1.length) { idMatch += r1.length; continue }
    
    if (t.name && t.name.length >= 2) {
      const { data: r2 } = await sb.from('trader_sources')
        .update({ avatar_url: t.avatar })
        .eq('source', exchange.source)
        .ilike('handle', t.name)
        .is('avatar_url', null)
        .select('id')
      if (r2 && r2.length) nameMatch += r2.length
    }
  }
  
  console.log('  ID匹配: ' + idMatch + ', 昵称匹配: ' + nameMatch)
  return { source: exchange.source, found: traders.size, idMatch, nameMatch }
}

async function main() {
  console.log('=== 万能头像补全 ===')
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  
  const results = []
  for (const ex of EXCHANGES) {
    try {
      results.push(await scrapeExchange(browser, ex))
    } catch (e) {
      console.log(ex.source + ' 失败: ' + e.message)
    }
  }
  
  await browser.close()
  
  console.log('\n=== 总结 ===')
  for (const r of results) {
    console.log(r.source + ': 找到' + r.found + ', ID匹配' + r.idMatch + ', 昵称匹配' + r.nameMatch)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

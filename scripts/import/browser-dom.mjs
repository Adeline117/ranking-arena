#!/usr/bin/env node
/**
 * DOM 直接提取 — 用于 CF 通不过或 JSON 拦截不到的平台
 * 直接从页面 DOM 提取交易员数据
 * 用法: node browser-dom.mjs <platform>
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

try { for (const l of readFileSync('.env.local','utf8').split('\n')) {
  const m=l.match(/^([^#=]+)=["']?(.+?)["']?$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]
}} catch{}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clip = (v,lo,hi) => Math.max(lo,Math.min(hi,v))
function cs(roi,p,d,w){if(roi==null)return null;return clip(Math.round((Math.min(70,roi>0?Math.log(1+roi/100)*25:Math.max(-70,roi/100*50))+(d!=null?Math.max(0,15*(1-d/100)):7.5)+(w!=null?Math.min(15,w/100*15):7.5))*10)/10,0,100)}

const PLATFORMS = {
  // MEXC: trader cards on copy-trading page
  mexc: {
    url: 'https://www.mexc.com/copy-trading',
    source: 'mexc',
    extract: `
      const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"]');
      const result = [];
      // Try getting from __NEXT_DATA__ or window state first
      if (window.__NEXT_DATA__?.props?.pageProps) {
        const pp = window.__NEXT_DATA__.props.pageProps;
        return JSON.stringify(pp);
      }
      // Try React fiber tree
      const root = document.getElementById('__next') || document.getElementById('app');
      if (root?._reactRootContainer || root?.['__reactFiber$' + Object.keys(root).find(k => k.startsWith('__reactFiber$'))?.slice(15)]) {
        // Can't easily extract from fiber, try DOM
      }
      // DOM extraction fallback
      cards.forEach(c => {
        const text = c.innerText;
        const nums = text.match(/[+-]?\\d+\\.\\d+%/g) || [];
        const name = c.querySelector('[class*="name"], [class*="nick"]')?.textContent?.trim();
        if (name && nums.length > 0) {
          result.push({ name, roi: parseFloat(nums[0]), raw: text.substring(0, 200) });
        }
      });
      return JSON.stringify(result);
    `,
  },
  // KuCoin: leaderboard with data in DOM
  kucoin: {
    url: 'https://www.kucoin.com/copy-trading/leaderboard',
    source: 'kucoin',
    extract: `
      // Try __NEXT_DATA__
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd) return nd.textContent;
      // Try window.__INITIAL_STATE__
      if (window.__INITIAL_STATE__) return JSON.stringify(window.__INITIAL_STATE__);
      // DOM fallback
      const rows = document.querySelectorAll('tr, [class*="row"], [class*="trader"], [class*="leader"]');
      const result = [];
      rows.forEach(r => {
        const text = r.innerText;
        const pcts = text.match(/[+-]?\\d+\\.\\d+%/g) || [];
        if (pcts.length > 0) result.push({ raw: text.substring(0, 300), pcts });
      });
      return JSON.stringify(result);
    `,
  },
  // Bitget: copy trading page
  bitget: {
    url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0',
    source: 'bitget_futures',
    extract: `
      // Try SSR data
      const scripts = [...document.querySelectorAll('script')];
      for (const s of scripts) {
        if (s.textContent.includes('traderList') || s.textContent.includes('leaderList')) {
          return s.textContent;
        }
      }
      if (window.__INITIAL_STATE__) return JSON.stringify(window.__INITIAL_STATE__);
      // DOM
      const items = document.querySelectorAll('[class*="trader"], [class*="card"]');
      const result = [];
      items.forEach(el => {
        const name = el.querySelector('[class*="name"]')?.textContent?.trim();
        const roi = el.querySelector('[class*="roi"], [class*="rate"]')?.textContent?.trim();
        if (name && roi) result.push({ name, roi: roi.substring(0, 20), text: el.innerText.substring(0, 200) });
      });
      return JSON.stringify(result);
    `,
  },
  // BingX: SSR rendered
  bingx: {
    url: 'https://bingx.com/en/copy-trading/',
    source: 'bingx',
    extract: `
      // Try __NEXT_DATA__
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd) return nd.textContent;
      // DOM
      const items = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"]');
      const result = [];
      items.forEach(el => {
        const text = el.innerText;
        const pcts = text.match(/[+-]?\\d+\\.\\d+%/g) || [];
        if (pcts.length > 0) result.push({ raw: text.substring(0, 300) });
      });
      return JSON.stringify(result);
    `,
  },
}

const name = process.argv[2]
if (!PLATFORMS[name]) { console.log('❌ unknown: ' + name); process.exit(1) }
const cfg = PLATFORMS[name]

async function main() {
  const browser = await chromium.launch({
    headless: false, executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome',
    proxy: { server: 'http://127.0.0.1:7890' },
    args: ['--window-size=400,300','--window-position=9999,9999',
      '--disable-gpu','--disable-extensions','--disable-dev-shm-usage',
      '--js-flags=--max-old-space-size=256'],
  })

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot,mp4,webm,ico}', r => r.abort())
  await page.route('**/{analytics,tracking,pixel,gtag,gtm,facebook,twitter,sentry}*', r => r.abort())

  try {
    await page.goto(cfg.url, { timeout: 45000, waitUntil: 'load' }).catch(()=>{})

    // CF wait
    let cfOk = false
    for (let i = 0; i < 30; i++) {
      const t = await page.title().catch(() => '')
      if (t && !t.includes('moment') && !t.includes('Check') && !t.includes('Verify') && t.length > 3) { cfOk = true; break }
      await sleep(1500)
    }
    if (!cfOk) { console.log('❌ CF'); await browser.close(); process.exit(1) }

    await sleep(10000)

    // Scroll
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{})
      await sleep(2000)
    }

    // Extract data from DOM
    const raw = await page.evaluate(cfg.extract).catch(e => '{"error":"' + e.message + '"}')
    console.log('RAW_LENGTH:', raw.length)
    
    // Try to parse and find trader data
    try {
      const data = JSON.parse(raw)
      console.log('PARSED:', typeof data === 'object' ? (Array.isArray(data) ? `array[${data.length}]` : Object.keys(data).slice(0, 10).join(',')) : typeof data)
      if (Array.isArray(data) && data.length > 0) {
        console.log('SAMPLE:', JSON.stringify(data[0]).substring(0, 300))
      } else if (typeof data === 'object') {
        // Look for arrays in the object
        const findArrays = (obj, path = '', depth = 0) => {
          if (depth > 4) return
          for (const [k, v] of Object.entries(obj)) {
            if (Array.isArray(v) && v.length > 2 && typeof v[0] === 'object') {
              console.log(`FOUND: ${path}.${k} [${v.length}] keys: ${Object.keys(v[0]).join(',')}`)
              console.log('SAMPLE:', JSON.stringify(v[0]).substring(0, 300))
            } else if (typeof v === 'object' && v && !Array.isArray(v)) {
              findArrays(v, path + '.' + k, depth + 1)
            }
          }
        }
        findArrays(data)
      }
    } catch { console.log('NOT_JSON, first 500:', raw.substring(0, 500)) }

  } finally {
    await browser.close().catch(()=>{})
  }
}

main()

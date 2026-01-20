/**
 * 专门获取 MEXC 交易员头像
 * 从交易员详情页面抓取头像 URL
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  console.log('=== 获取 MEXC 交易员头像 ===')
  
  // 获取没有头像的 MEXC 交易员
  const { data: traders } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', 'mexc')
    .is('profile_url', null)
    .limit(50)
  
  if (!traders || traders.length === 0) {
    console.log('没有需要获取头像的交易员')
    return
  }
  
  console.log(`找到 ${traders.length} 个需要获取头像的交易员`)
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  
  let updated = 0
  
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    
    for (const trader of traders) {
      try {
        const url = `https://www.mexc.com/futures/copyTrade/trader/${trader.source_trader_id}`
        console.log(`  访问: ${trader.handle} (${trader.source_trader_id})`)
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
        await sleep(2000)
        
        // 提取头像 URL - 排除广告和追踪链接
        const avatar = await page.evaluate(() => {
          const imgs = document.querySelectorAll('img')
          
          for (const img of imgs) {
            const src = img.src || ''
            // 排除广告、追踪、默认图片
            if (src.includes('t.co') || 
                src.includes('twitter') ||
                src.includes('facebook') ||
                src.includes('google') ||
                src.includes('banner') ||
                src.includes('default') ||
                src.includes('placeholder') ||
                src.includes('icon') ||
                src.includes('logo') ||
                src.length < 30) {
              continue
            }
            
            // 检查是否是用户头像
            if (src.includes('avatar') || 
                src.includes('user') || 
                src.includes('head') ||
                src.includes('profile') ||
                src.includes('mocortech')) {
              return src
            }
          }
          return null
        })
        
        if (avatar) {
          console.log(`    ✅ 找到头像: ${avatar.substring(0, 50)}...`)
          
          await supabase
            .from('trader_sources')
            .update({ profile_url: avatar })
            .eq('source', 'mexc')
            .eq('source_trader_id', trader.source_trader_id)
          
          updated++
        } else {
          console.log(`    ❌ 未找到头像`)
        }
        
        await sleep(1000)
      } catch (e) {
        console.log(`    ⚠ 错误: ${e.message}`)
      }
    }
  } finally {
    await browser.close()
  }
  
  console.log(`\n=== 完成: 更新了 ${updated} 个头像 ===`)
}

main().catch(console.error)

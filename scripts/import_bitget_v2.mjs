/**
 * Bitget 数据抓取 v2 - 绕过 Cloudflare
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const URLS = [
  { type: 'futures', period: '90', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=90' },
  { type: 'futures', period: '30', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=30' },
  { type: 'futures', period: '7', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=7' },
  { type: 'spot', period: '90', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=90' },
  { type: 'spot', period: '30', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=30' },
  { type: 'spot', period: '7', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=7' },
]

async function main() {
  console.log('=== Bitget 数据抓取 v2 ===\n')

  const browser = await puppeteer.launch({
    headless: false, // 使用有头模式绕过 Cloudflare
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  })

  try {
    const page = await browser.newPage()
    
    // 设置真实的 User-Agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    
    // 隐藏 webdriver 特征
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
      window.chrome = { runtime: {} }
    })

    const allTraders = new Map()
    
    for (const config of URLS) {
      console.log(`\n📊 抓取 ${config.type} ${config.period}D...`)
      
      try {
        await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        
        // 等待 Cloudflare 检查完成
        console.log('  等待页面加载...')
        await sleep(8000)
        
        // 检查是否还在 Cloudflare 检查页面
        const isCloudflare = await page.evaluate(() => {
          return document.body.innerText.includes('Just a moment') || 
                 document.body.innerText.includes('Checking your browser')
        })
        
        if (isCloudflare) {
          console.log('  等待 Cloudflare 验证...')
          await sleep(10000)
        }
        
        // 滚动页面加载更多数据
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollBy(0, 500))
          await sleep(500)
        }
        
        // 尝试提取数据
        const traders = await page.evaluate(() => {
          const results = []
          
          // 方法1: 查找排行榜项目
          const items = document.querySelectorAll('[class*="ranking"], [class*="leaderboard"], [class*="trader"], [class*="item"], [class*="row"], [class*="card"]')
          
          items.forEach((item, idx) => {
            const text = item.innerText || ''
            
            // 提取 ROI
            const roiMatch = text.match(/([+-]?\d+(?:,?\d+)*\.?\d*)%/)
            if (!roiMatch) return
            
            const roi = parseFloat(roiMatch[1].replace(/,/g, ''))
            if (isNaN(roi) || roi === 0) return
            
            // 提取链接
            const link = item.querySelector('a[href*="trader"]')
            let traderId = null
            let profileUrl = null
            if (link) {
              const href = link.getAttribute('href')
              profileUrl = href?.startsWith('http') ? href : `https://www.bitget.com${href}`
              const idMatch = href?.match(/trader[\/\-]?(\d+)/i) || href?.match(/uid[=\/](\d+)/i)
              traderId = idMatch ? idMatch[1] : null
            }
            
            // 如果没有 traderId，尝试生成一个
            if (!traderId) {
              traderId = `bitget_${Date.now()}_${idx}`
            }
            
            // 提取昵称
            let nickname = null
            const nameEl = item.querySelector('[class*="name"], [class*="nick"]')
            if (nameEl) {
              nickname = nameEl.innerText?.trim()?.split('\n')[0]
            }
            
            // 提取头像
            const avatarEl = item.querySelector('img')
            const avatar = avatarEl?.src || null
            
            // 提取粉丝数
            const followersMatch = text.match(/(\d+(?:,\d+)*)\s*(?:跟随|followers|copiers)/i)
            const followers = followersMatch ? parseInt(followersMatch[1].replace(/,/g, '')) : null
            
            // 提取胜率
            const winRateMatch = text.match(/(?:胜率|win\s*rate)[:\s]*(\d+\.?\d*)%/i)
            const winRate = winRateMatch ? parseFloat(winRateMatch[1]) : null
            
            results.push({
              rank: results.length + 1,
              traderId,
              nickname,
              avatar,
              profileUrl,
              roi,
              followers,
              winRate,
            })
          })
          
          return results
        })
        
        console.log(`  获取到 ${traders.length} 个交易员`)
        
        // 合并数据
        const sourceType = config.type === 'futures' ? 'bitget' : 'bitget_spot'
        for (const trader of traders) {
          const key = `${sourceType}_${trader.traderId}`
          const existing = allTraders.get(key) || {
            source: sourceType,
            traderId: trader.traderId,
            nickname: trader.nickname,
            avatar: trader.avatar,
            profileUrl: trader.profileUrl,
            followers: trader.followers,
          }
          
          if (config.period === '7') {
            existing.roi_7d = trader.roi
            existing.winRate_7d = trader.winRate
          } else if (config.period === '30') {
            existing.roi_30d = trader.roi
            existing.winRate_30d = trader.winRate
          } else {
            existing.roi = trader.roi
            existing.winRate = trader.winRate
            existing.rank = trader.rank
          }
          
          allTraders.set(key, existing)
        }
        
      } catch (error) {
        console.log(`  ❌ 错误: ${error.message}`)
      }
      
      await sleep(3000)
    }
    
    // 保存数据
    console.log(`\n📥 保存 ${allTraders.size} 个交易员...`)
    const capturedAt = new Date().toISOString()
    
    for (const [key, trader] of allTraders) {
      await saveTrader(trader, capturedAt)
    }
    
    console.log('\n✅ 完成!')
    
  } finally {
    await browser.close()
  }
}

async function saveTrader(trader, capturedAt) {
  try {
    // 保存 trader_sources
    await supabase.from('trader_sources').upsert({
      source: trader.source,
      source_type: 'leaderboard',
      source_trader_id: trader.traderId,
      handle: trader.nickname || null,
      profile_url: trader.avatar || null,
      is_active: true,
    }, { onConflict: 'source,source_trader_id' })

    // 保存 trader_snapshots
    await supabase.from('trader_snapshots').upsert({
      source: trader.source,
      source_trader_id: trader.traderId,
      rank: trader.rank || null,
      roi: trader.roi || 0,
      roi_7d: trader.roi_7d || null,
      roi_30d: trader.roi_30d || null,
      win_rate: trader.winRate || null,
      followers: 0,
      season_id: '90D',
      captured_at: capturedAt,
    }, { onConflict: 'source,source_trader_id,captured_at' })
    
    console.log(`  ✓ ${trader.nickname || trader.traderId}`)
  } catch (e) {
    // 静默
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

main().catch(console.error)


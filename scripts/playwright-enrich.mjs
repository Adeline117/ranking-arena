#!/usr/bin/env node
/**
 * playwright-enrich.mjs — 用 Playwright 浏览器绕过 bot 防护，补齐 snapshot 缺失字段
 *
 * 通过浏览器访问各平台排行榜页面，拦截 API 请求获取数据，更新缺失的 pnl/win_rate/max_drawdown/trades_count
 *
 * Usage: node scripts/playwright-enrich.mjs [--source=xxx] [--dry-run]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null

// 各平台配置
const PLATFORM_CONFIG = {
  kucoin: {
    name: 'KuCoin',
    pageUrl: 'https://www.kucoin.com/copy-trading',
    apiUrl: 'https://www.kucoin.com/_api/ct-copy-trade',
    dataPath: ['data', 'items'],
    traderIdField: 'leadConfigId',
    fieldMapping: {
      pnl_usd: 'totalPnl',
      win_rate: null, // KuCoin API 不提供胜率
      max_drawdown: null, // KuCoin API 不提供最大回撤
      trades_count: null // KuCoin API 不提供交易次数
    }
  },
  mexc: {
    name: 'MEXC',
    pageUrl: 'https://www.mexc.com/copy-trading',
    apiUrl: 'https://www.mexc.com/api/platform/copy-trade/trader/list',
    dataPath: ['data', 'list'],
    traderIdField: 'traderId',
    fieldMapping: {
      pnl_usd: 'pnl',
      win_rate: 'winRate',
      max_drawdown: 'maxDrawdown',
      trades_count: 'totalOrder'
    }
  },
  coinex: {
    name: 'CoinEx',
    pageUrl: 'https://www.coinex.com/copy-trading',
    apiUrl: 'https://www.coinex.com/res/copy-trading/traders',
    dataPath: ['data'],
    traderIdField: 'user_id',
    fieldMapping: {
      pnl_usd: 'pnl',
      win_rate: 'win_rate',
      max_drawdown: 'max_drawdown',
      trades_count: 'trades_count'
    }
  },
  bitget: {
    name: 'Bitget',
    pageUrl: 'https://www.bitget.com/copy-trading',
    apiUrl: 'https://www.bitget.com/v1/trigger/trace/queryCopyTraderList',
    dataPath: ['data'],
    traderIdField: 'traderId',
    fieldMapping: {
      pnl_usd: 'pnl',
      win_rate: 'winRate',
      max_drawdown: 'maxDrawdown',
      trades_count: 'totalTrades'
    }
  },
  bybit: {
    name: 'Bybit',
    pageUrl: 'https://www.bybit.com/copyTrading/traderRanking',
    apiUrl: 'https://api2.bybit.com/fapi/beehive/public/v2/common/leader/list',
    dataPath: ['result', 'leaderDetails'],
    traderIdField: 'leaderMark',
    fieldMapping: {
      pnl_usd: 'pnl',
      win_rate: 'winRate',
      max_drawdown: 'maxDrawdown',
      trades_count: 'totalTradingCount'
    }
  },
  htx: {
    name: 'HTX',
    pageUrl: 'https://www.htx.com/copy-trading',
    apiUrl: 'https://www.htx.com/v1/copy-trading/public/trader/list',
    dataPath: ['data'],
    traderIdField: 'traderId',
    fieldMapping: {
      pnl_usd: 'pnl',
      win_rate: 'winRate',
      max_drawdown: 'maxDrawdown',
      trades_count: 'tradeCnt'
    }
  },
  okx: {
    name: 'OKX',
    pageUrl: 'https://www.okx.com/copy-trading/leaderboard',
    apiUrl: 'https://www.okx.com/priapi/v5/ecotrade/public/leader-board',
    dataPath: ['data'],
    traderIdField: 'uniqueName',
    fieldMapping: {
      pnl_usd: 'pnl',
      win_rate: 'winRate',
      max_drawdown: 'maxDrawdown',
      trades_count: 'ordCnt'
    }
  },
  binance: {
    name: 'Binance',
    pageUrl: 'https://www.binance.com/en/copy-trading',
    apiUrl: 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
    dataPath: ['data', 'list'],
    traderIdField: 'leadPortfolioId',
    fieldMapping: {
      pnl_usd: 'pnl',
      win_rate: 'winRate',
      max_drawdown: 'maxDrawdown',
      trades_count: 'totalTrades'
    }
  }
}

// 解析字段值
function parseNumber(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    // Remove % and parse as number
    const cleaned = value.replace(/[%,\s]/g, '')
    const num = parseFloat(cleaned)
    return isNaN(num) ? null : num
  }
  return null
}

// 从嵌套对象中获取值
function getNestedValue(obj, path) {
  return path.reduce((current, key) => current && current[key], obj)
}

// 等待随机延迟
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 获取随机延迟时间
function getRandomDelay(min = 1000, max = 3000) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// 使用 Playwright 获取平台数据
async function fetchPlatformData(platformKey, config) {
  console.log(`\n🌐 Launching browser for ${config.name}...`)
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  })
  
  const page = await context.newPage()
  const allTraders = new Map() // trader_id → trader_data
  
  try {
    // 拦截所有API响应
    let responseCount = 0
    page.on('response', async (response) => {
      const url = response.url()
      const apiUrlBase = config.apiUrl.split('?')[0] // 移除查询参数
      
      // 记录所有API相关的请求
      if (url.includes('/api/') || url.includes('/_api/') || url.includes('leader') || url.includes('ranking') || url.includes('copy') || url.includes(config.name.toLowerCase())) {
        console.log(`  🌍 Detected API call: ${url}`)
      }
      
      if (url.includes(apiUrlBase) || url.includes('leader') || url.includes('ranking') || url.includes('copy-trade')) {
        responseCount++
        console.log(`  📡 Intercepted API response #${responseCount}: ${url}`)
        console.log(`    📊 Status: ${response.status()}`)
        console.log(`    📋 Content-Type: ${response.headers()['content-type']}`)
        
        try {
          if (response.status() === 200 && response.headers()['content-type']?.includes('application/json')) {
            const responseBody = await response.json()
            console.log(`    🔍 Response structure:`, Object.keys(responseBody))
            
            const traders = getNestedValue(responseBody, config.dataPath)
            
            if (Array.isArray(traders)) {
              console.log(`    📊 Found ${traders.length} traders in response`)
              console.log(`    🔍 Sample trader:`, JSON.stringify(traders[0], null, 2))
              
              for (const trader of traders) {
                const traderId = trader[config.traderIdField] || trader.uid || trader.id
                if (!traderId) {
                  console.log(`    ⚠ No trader ID found for trader:`, Object.keys(trader))
                  continue
                }
                
                console.log(`    👤 Processing trader ${traderId}:`, {
                  pnl: trader[config.fieldMapping.pnl_usd],
                  win_rate: trader[config.fieldMapping.win_rate],
                  max_drawdown: trader[config.fieldMapping.max_drawdown],
                  trades_count: trader[config.fieldMapping.trades_count]
                })
                
                const traderData = {
                  trader_id: traderId,
                  pnl: parseNumber(trader[config.fieldMapping.pnl_usd]),
                  win_rate: parseNumber(trader[config.fieldMapping.win_rate]),
                  max_drawdown: parseNumber(trader[config.fieldMapping.max_drawdown]),
                  trades_count: parseNumber(trader[config.fieldMapping.trades_count])
                }
                
                allTraders.set(traderId, traderData)
              }
            } else if (traders) {
              console.log(`    ⚠ Traders data is not an array, type: ${typeof traders}`)
              console.log(`    🔍 Traders data:`, JSON.stringify(traders, null, 2))
            } else {
              console.log(`    ⚠ No traders data found at path:`, config.dataPath)
              console.log(`    🔍 Available keys:`, Object.keys(responseBody))
              console.log(`    🔍 Sample data:`, JSON.stringify(responseBody).substring(0, 1000))
            }
          }
        } catch (error) {
          console.log(`    ⚠ Failed to parse response: ${error.message}`)
        }
      }
    })
    
    // 访问页面
    console.log(`  🔗 Loading ${config.pageUrl}`)
    await page.goto(config.pageUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    })
    
    // 等待页面加载并触发数据请求
    console.log(`  ⏳ Waiting for page to load...`)
    await sleep(5000)
    
    // 尝试滚动来触发更多数据加载
    console.log(`  📜 Scrolling to trigger data loading...`)
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2)
    })
    await sleep(2000)
    
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await sleep(2000)
    
    // 查找并点击分页或加载更多按钮
    try {
      const buttons = await page.$$('button, a, div[role="button"]')
      for (const button of buttons) {
        const text = await button.textContent()
        if (text && /next|more|load|下一页|加载更多|翻页|page/i.test(text)) {
          console.log(`  👆 Found button with text: "${text}", clicking...`)
          await button.click()
          await sleep(3000)
          break
        }
      }
    } catch (error) {
      console.log(`  ⚠ Button interaction failed: ${error.message}`)
    }
    
    // 最后等待一下确保所有请求完成
    console.log(`  ⌛ Final wait for network to settle...`)
    await sleep(3000)
    
  } catch (error) {
    console.log(`  ⚠ Error processing ${config.name}: ${error.message}`)
  } finally {
    await browser.close()
  }
  
  console.log(`  ✅ Collected data for ${allTraders.size} traders from ${config.name}`)
  return allTraders
}

// 检查数据缺口
async function checkDataGaps(source) {
  const { count: totalSnaps } = await supabase.from('trader_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('source', source)
  
  const missingFields = {}
  for (const field of ['pnl', 'win_rate', 'max_drawdown', 'trades_count']) {
    const { count } = await supabase.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('source', source)
      .is(field, null)
    missingFields[field] = count
  }
  
  console.log(`  📊 Total snapshots: ${totalSnaps}`)
  console.log(`  📉 Missing: pnl=${missingFields.pnl}, win_rate=${missingFields.win_rate}, max_drawdown=${missingFields.max_drawdown}, trades_count=${missingFields.trades_count}`)
  
  return { totalSnaps, missingFields }
}

// 更新数据库
async function updateDatabase(source, tradersData, gaps) {
  let updated = 0
  let processed = 0
  
  console.log(`  🔄 Processing ${tradersData.size} traders...`)
  
  for (const [traderId, data] of tradersData) {
    processed++
    
    // 获取该交易员的快照
    const { data: snapshots } = await supabase.from('trader_snapshots')
      .select('id, pnl, win_rate, max_drawdown, trades_count')
      .eq('source', source)
      .eq('source_trader_id', traderId)
    
    if (!snapshots?.length) continue
    
    for (const snapshot of snapshots) {
      const updates = {}
      
      if (snapshot.pnl === null && data.pnl !== null) {
        updates.pnl = data.pnl
      }
      if (snapshot.win_rate === null && data.win_rate !== null) {
        updates.win_rate = data.win_rate
      }
      if (snapshot.max_drawdown === null && data.max_drawdown !== null) {
        updates.max_drawdown = data.max_drawdown
      }
      if (snapshot.trades_count === null && data.trades_count !== null) {
        updates.trades_count = data.trades_count
      }
      
      if (Object.keys(updates).length === 0) continue
      
      if (!DRY_RUN) {
        const { error } = await supabase.from('trader_snapshots')
          .update(updates)
          .eq('id', snapshot.id)
        
        if (error) {
          console.log(`    ⚠ Update failed for snapshot ${snapshot.id}: ${error.message}`)
        } else {
          updated++
        }
      } else {
        console.log(`    💫 Would update snapshot ${snapshot.id} with: ${JSON.stringify(updates)}`)
        updated++
      }
    }
    
    // 每处理 50 个交易员打印一次进度
    if (processed % 50 === 0) {
      console.log(`    📈 Processed ${processed}/${tradersData.size} traders, updated ${updated} snapshots`)
    }
  }
  
  console.log(`  ✅ Updated ${updated} snapshots from ${tradersData.size} traders ${DRY_RUN ? '(DRY RUN)' : ''}`)
  return updated
}

// 处理单个平台
async function enrichPlatform(source) {
  const config = PLATFORM_CONFIG[source]
  if (!config) {
    console.log(`⚠ No configuration for source: ${source}`)
    return
  }
  
  console.log(`\n🔄 Processing ${config.name} (${source})`)
  
  // 检查数据缺口
  const gaps = await checkDataGaps(source)
  if (Object.values(gaps.missingFields).every(v => v === 0)) {
    console.log(`  ✅ All fields complete for ${source}`)
    return
  }
  
  // 使用 Playwright 获取数据
  const tradersData = await fetchPlatformData(source, config)
  
  if (tradersData.size === 0) {
    console.log(`  ⚠ No trader data collected for ${source}`)
    return
  }
  
  // 更新数据库
  await updateDatabase(source, tradersData, gaps)
  
  // 添加延迟避免过于频繁的请求
  console.log(`  ⏳ Waiting 5 seconds before next platform...`)
  await sleep(5000)
}

// 主函数
async function main() {
  console.log(`\n🤖 Playwright Snapshot Enrichment ${DRY_RUN ? '(DRY RUN)' : ''}\n`)
  console.log(`💻 Using Chromium at: ${process.env.PLAYWRIGHT_BROWSERS_PATH || 'default location'}`)
  
  // 确定要处理的平台
  const platforms = SOURCE_FILTER 
    ? [SOURCE_FILTER]
    : Object.keys(PLATFORM_CONFIG)
  
  console.log(`🎯 Target platforms: ${platforms.join(', ')}`)
  
  for (const source of platforms) {
    try {
      await enrichPlatform(source)
    } catch (error) {
      console.log(`❌ Failed to process ${source}: ${error.message}`)
      console.error(error)
    }
  }
  
  // 最终统计
  console.log('\n═══ Final Statistics ═══')
  for (const field of ['pnl', 'win_rate', 'max_drawdown', 'trades_count']) {
    const { count: total } = await supabase.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
    const { count: filled } = await supabase.from('trader_snapshots')
      .select('id', { count: 'exact', head: true })
      .not(field, 'is', null)
    const percentage = total > 0 ? Math.round(filled/total*100) : 0
    console.log(`  ${field.padEnd(16)} ${filled}/${total} (${percentage}%)`)
  }
  
  console.log('\n✨ Enrichment complete!')
}

// 启动脚本
main().catch(error => {
  console.error('\n❌ Script failed:', error)
  process.exit(1)
})
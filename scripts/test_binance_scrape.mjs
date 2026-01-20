#!/usr/bin/env node
/**
 * 测试 Binance 抓取 API（部署后运行）
 * 
 * 用法:
 *   node scripts/test_binance_scrape.mjs                    # 测试所有时间段
 *   node scripts/test_binance_scrape.mjs 7D                 # 测试单个时间段
 *   node scripts/test_binance_scrape.mjs --verify           # 只验证数据库数据
 *   VERCEL_URL=xxx node scripts/test_binance_scrape.mjs     # 指定 Vercel URL
 */

import 'dotenv/config'

const BASE_URL = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}`
  : 'https://ranking-arena.vercel.app'

const PERIODS = ['7D', '30D', '90D']

async function testScrapeApi(period) {
  const url = period === 'all' 
    ? `${BASE_URL}/api/scrape/binance?period=all`
    : `${BASE_URL}/api/scrape/binance?period=${period}`
  
  console.log(`\n🔄 测试: ${url}`)
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })
    
    if (!response.ok) {
      console.log(`  ❌ HTTP ${response.status}`)
      return null
    }
    
    const data = await response.json()
    
    if (data.success) {
      if (data.results) {
        // 批量抓取结果
        console.log(`  ✅ 成功！耗时: ${(data.duration / 1000).toFixed(1)}s`)
        for (const r of data.results) {
          console.log(`\n  === ${r.period} ===`)
          if (r.success) {
            console.log(`  获取: ${r.fetched}, 保存: ${r.saved}`)
            if (r.top5) {
              r.top5.forEach((t, i) => {
                console.log(`    ${i + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
              })
            }
          } else {
            console.log(`  ❌ 失败: ${r.error}`)
          }
        }
      } else {
        // 单时间段结果
        console.log(`  ✅ 成功！`)
        console.log(`  获取: ${data.fetched}, 保存: ${data.saved}`)
        if (data.top5) {
          data.top5.forEach((t, i) => {
            console.log(`    ${i + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
          })
        }
      }
      return data
    } else {
      console.log(`  ❌ API 错误: ${data.message || data.error}`)
      return null
    }
  } catch (e) {
    console.log(`  ❌ 请求失败: ${e.message}`)
    return null
  }
}

async function verifyDatabaseData() {
  console.log(`\n📊 验证数据库数据...`)
  
  const url = `${BASE_URL}/api/admin/data-report`
  
  try {
    const response = await fetch(url)
    const data = await response.json()
    
    if (!data.ok) {
      console.log(`  ❌ 获取报告失败`)
      return
    }
    
    const binanceFutures = data.reports?.find(r => r.source === 'binance_futures')
    
    if (binanceFutures) {
      console.log(`\n  === Binance Futures ===`)
      for (const period of binanceFutures.periods) {
        const status = period.isStale ? '⚠️ 陈旧' : '✅'
        console.log(`  ${status} ${period.period}: ${period.traderCount} 条, 更新: ${period.lastUpdate || '无'}`)
        
        if (period.top10?.length > 0) {
          console.log(`      TOP 3:`)
          period.top10.slice(0, 3).forEach((t, i) => {
            console.log(`        ${i + 1}. ${t.handle || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
          })
        }
      }
    }
  } catch (e) {
    console.log(`  ❌ 请求失败: ${e.message}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const verifyOnly = args.includes('--verify')
  const period = args.find(a => PERIODS.includes(a.toUpperCase()))?.toUpperCase()
  
  console.log(`╔════════════════════════════════════════════════════════╗`)
  console.log(`║     🧪 Binance 抓取 API 测试                           ║`)
  console.log(`╚════════════════════════════════════════════════════════╝`)
  console.log(`目标: ${BASE_URL}`)
  console.log(`时间: ${new Date().toISOString()}`)
  
  if (verifyOnly) {
    await verifyDatabaseData()
    return
  }
  
  if (period) {
    // 测试单个时间段
    await testScrapeApi(period)
  } else {
    // 测试所有时间段
    await testScrapeApi('all')
  }
  
  // 验证数据
  await verifyDatabaseData()
  
  console.log(`\n✅ 测试完成！`)
}

main().catch(console.error)

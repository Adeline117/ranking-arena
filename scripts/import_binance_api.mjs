/**
 * Binance 数据抓取 - 直接 API 调用方式
 * 通过 Binance 公开 API 获取 Copy Trading 排行榜数据
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Binance Copy Trading API 端点
const API_ENDPOINTS = [
  // v1 API
  {
    url: 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
    method: 'POST',
    body: (timeRange, pageNo = 1) => ({
      pageNo,
      pageSize: 50,
      timeRange, // WEEKLY(7D), MONTHLY(30D), QUARTERLY(90D), ALL
      dataType: null,
      favoriteOnly: false,
      hideFull: false,
      nickname: null,
      order: 'DESC',
      orderBy: 'ROI',
    }),
  },
  // v2 API
  {
    url: 'https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade/home-page/query-list',
    method: 'POST',
    body: (timeRange, pageNo = 1) => ({
      pageNo,
      pageSize: 50,
      timeRange,
      dataType: null,
      favoriteOnly: false,
      hideFull: false,
      nickname: null,
      order: 'DESC',
      orderBy: 'ROI',
    }),
  },
  // 公开 API
  {
    url: 'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/list',
    method: 'POST',
    body: (timeRange, pageNo = 1) => ({
      page: pageNo,
      rows: 50,
      statisticsPeriod: timeRange === 'WEEKLY' ? 7 : timeRange === 'MONTHLY' ? 30 : 90,
      sortField: 'ROI',
      sortType: 'DESC',
    }),
  },
]

const TIME_RANGES = [
  { api: 'QUARTERLY', label: '90D', days: 90 },
  { api: 'MONTHLY', label: '30D', days: 30 },
  { api: 'WEEKLY', label: '7D', days: 7 },
]

const HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://www.binance.com',
  'Referer': 'https://www.binance.com/en/copy-trading/leaderboard',
}

async function main() {
  console.log('=== Binance 数据抓取 (直接 API 模式) ===\n')
  console.log('开始时间:', new Date().toISOString())

  const allTraders = new Map()

  // 尝试每个 API 端点
  for (const endpoint of API_ENDPOINTS) {
    console.log(`\n🔗 尝试 API: ${endpoint.url.split('/').slice(-3).join('/')}`)
    
    let success = false
    
    for (const timeRange of TIME_RANGES) {
      console.log(`\n  📊 获取 ${timeRange.label} 数据...`)
      
      try {
        const body = endpoint.body(timeRange.api, 1)
        
        const response = await fetch(endpoint.url, {
          method: endpoint.method,
          headers: HEADERS,
          body: JSON.stringify(body),
        })
        
        if (!response.ok) {
          console.log(`    ✗ HTTP ${response.status}: ${response.statusText}`)
          continue
        }
        
        const data = await response.json()
        
        if (data.code !== '000000' && data.code !== 0 && !data.success) {
          console.log(`    ✗ API 错误: ${data.message || data.msg || JSON.stringify(data)}`)
          continue
        }
        
        const list = data.data?.list || data.data?.data || data.data || []
        
        if (!Array.isArray(list) || list.length === 0) {
          console.log(`    ✗ 无数据返回`)
          continue
        }
        
        console.log(`    ✓ 获取到 ${list.length} 个交易员`)
        success = true
        
        // 处理数据
        list.forEach((item, idx) => {
          const traderId = String(item.portfolioId || item.encryptedUid || item.leadPortfolioId || '')
          if (!traderId) return
          
          const existing = allTraders.get(traderId) || {
            source: 'binance',
            traderId,
          }
          
          // 基本信息
          existing.nickname = existing.nickname || item.nickName || item.nickname || item.displayName
          existing.avatar = existing.avatar || item.userPhoto || item.avatar || item.avatarUrl
          existing.profileUrl = existing.profileUrl || `https://www.binance.com/en/copy-trading/lead-details?portfolioId=${traderId}`
          
          // 按时间段存储 ROI 和 PnL
          const roi = parseFloat(item.roi ?? item.roiPct ?? item.roiRate ?? 0)
          const pnl = parseFloat(item.pnl ?? item.profit ?? item.totalProfit ?? 0)
          const winRate = parseFloat(item.winRate ?? item.winRatio ?? item.profitRate ?? 0)
          
          if (timeRange.days === 7) {
            existing.roi_7d = roi
            existing.pnl_7d = pnl
            existing.winRate_7d = winRate
          } else if (timeRange.days === 30) {
            existing.roi_30d = roi
            existing.pnl_30d = pnl
            existing.winRate_30d = winRate
          } else {
            existing.roi = roi
            existing.pnl = pnl
            existing.winRate = winRate
            existing.rank = idx + 1
          }
          
          // 通用数据
          existing.followers = existing.followers ?? parseInt(item.copierCount || item.followerCount || item.followers || 0)
          existing.maxDrawdown = existing.maxDrawdown ?? parseFloat(item.mdd || item.maxDrawdown || 0)
          existing.tradesCount = existing.tradesCount ?? parseInt(item.tradeCount || item.positionCount || 0)
          existing.aum = existing.aum ?? parseFloat(item.aum || item.totalAssets || 0)
          
          allTraders.set(traderId, existing)
        })
        
        // 获取更多页
        if (list.length >= 50) {
          for (let page = 2; page <= 5; page++) {
            await sleep(500)
            
            try {
              const pageBody = endpoint.body(timeRange.api, page)
              const pageResponse = await fetch(endpoint.url, {
                method: endpoint.method,
                headers: HEADERS,
                body: JSON.stringify(pageBody),
              })
              
              if (!pageResponse.ok) break
              
              const pageData = await pageResponse.json()
              const pageList = pageData.data?.list || pageData.data?.data || pageData.data || []
              
              if (!Array.isArray(pageList) || pageList.length === 0) break
              
              console.log(`    + 第 ${page} 页: ${pageList.length} 个`)
              
              pageList.forEach((item, idx) => {
                const traderId = String(item.portfolioId || item.encryptedUid || item.leadPortfolioId || '')
                if (!traderId) return
                
                const existing = allTraders.get(traderId) || {
                  source: 'binance',
                  traderId,
                }
                
                existing.nickname = existing.nickname || item.nickName || item.nickname
                existing.avatar = existing.avatar || item.userPhoto || item.avatar
                existing.profileUrl = existing.profileUrl || `https://www.binance.com/en/copy-trading/lead-details?portfolioId=${traderId}`
                
                const roi = parseFloat(item.roi ?? item.roiPct ?? 0)
                const pnl = parseFloat(item.pnl ?? item.profit ?? 0)
                const winRate = parseFloat(item.winRate ?? item.winRatio ?? 0)
                
                if (timeRange.days === 7) {
                  existing.roi_7d = roi
                  existing.pnl_7d = pnl
                  existing.winRate_7d = winRate
                } else if (timeRange.days === 30) {
                  existing.roi_30d = roi
                  existing.pnl_30d = pnl
                  existing.winRate_30d = winRate
                } else {
                  existing.roi = roi
                  existing.pnl = pnl
                  existing.winRate = winRate
                  existing.rank = (page - 1) * 50 + idx + 1
                }
                
                existing.followers = existing.followers ?? parseInt(item.copierCount || item.followerCount || 0)
                existing.maxDrawdown = existing.maxDrawdown ?? parseFloat(item.mdd || item.maxDrawdown || 0)
                
                allTraders.set(traderId, existing)
              })
            } catch (e) {
              console.log(`    ✗ 第 ${page} 页失败: ${e.message}`)
              break
            }
          }
        }
        
      } catch (error) {
        console.log(`    ✗ 请求失败: ${error.message}`)
      }
      
      await sleep(1000)
    }
    
    if (success) {
      console.log(`\n✓ API ${endpoint.url.split('/').slice(-2).join('/')} 可用`)
      break
    }
  }

  console.log(`\n📥 保存 ${allTraders.size} 个交易员数据...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0
  let errors = 0
  
  for (const [key, trader] of allTraders) {
    const result = await saveTrader(trader, capturedAt)
    if (result) {
      saved++
    } else {
      errors++
    }
  }
  
  console.log(`  ✓ 保存了 ${saved} 个交易员`)
  if (errors > 0) {
    console.log(`  ✗ ${errors} 个保存失败`)
  }
  
  // 显示示例数据
  if (allTraders.size > 0) {
    console.log('\n📋 示例数据:')
    const sample = Array.from(allTraders.values())[0]
    console.log(`  交易员: ${sample.nickname || sample.traderId}`)
    console.log(`  90D ROI: ${sample.roi}%`)
    console.log(`  30D ROI: ${sample.roi_30d}%`)
    console.log(`  7D ROI: ${sample.roi_7d}%`)
  }

  console.log('\n✅ 完成!')
  console.log('结束时间:', new Date().toISOString())
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

    // 为每个时间段创建独立的 snapshot 记录
    const periods = [
      { season_id: '7D', roi: trader.roi_7d, pnl: trader.pnl_7d, winRate: trader.winRate_7d, rank: null },
      { season_id: '30D', roi: trader.roi_30d, pnl: trader.pnl_30d, winRate: trader.winRate_30d, rank: null },
      { season_id: '90D', roi: trader.roi, pnl: trader.pnl, winRate: trader.winRate, rank: trader.rank },
    ]

    let savedAny = false
    for (const period of periods) {
      if (period.roi !== undefined && period.roi !== null && !isNaN(period.roi)) {
        const { error } = await supabase.from('trader_snapshots').upsert({
          source: trader.source,
          source_trader_id: trader.traderId,
          season_id: period.season_id,
          rank: period.rank || null,
          roi: period.roi,
          pnl: period.pnl || null,
          win_rate: period.winRate || null,
          max_drawdown: trader.maxDrawdown || null,
          followers: trader.followers || 0,
          captured_at: capturedAt,
        }, { onConflict: 'source,source_trader_id,season_id,captured_at' })
        
        if (error) {
          console.error(`  ✗ ${trader.traderId} ${period.season_id}: ${error.message}`)
        } else {
          savedAny = true
        }
      }
    }

    return savedAny
  } catch (error) {
    console.error(`  ✗ 保存失败 ${trader.traderId}: ${error.message}`)
    return false
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(console.error)

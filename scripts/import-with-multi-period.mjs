#!/usr/bin/env node
/**
 * 导入交易员时同时抓取三个时间段的 ROI
 * 7d, 30d, 90d (all-time)
 * 
 * 解决问题：新导入交易员无历史快照
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// 各平台的 ROI API 端点配置
const PLATFORMS = {
  bitget_futures: {
    baseUrl: 'https://api.bitget.com/api/v2/copy/futures-trader/public/profit-detail',
    periods: { '7D': '7d', '30D': '30d', 'ALL': 'all' },
    parseResponse: (data) => ({
      roi_7d: data?.data?.['7D']?.roi ? parseFloat(data.data['7D'].roi) * 100 : null,
      roi_30d: data?.data?.['30D']?.roi ? parseFloat(data.data['30D'].roi) * 100 : null,
      roi: data?.data?.['ALL']?.roi ? parseFloat(data.data['ALL'].roi) * 100 : null
    })
  },
  bybit: {
    baseUrl: 'https://api.bybit.com/v5/copy-trade/leaderboard/v5/trader',
    periods: { 'period=7': '7d', 'period=30': '30d', 'period=0': 'all' },
    parseResponse: (data) => ({
      roi_7d: data?.result?.list?.[0]?.roi7days ? parseFloat(data.result.list[0].roi7days) : null,
      roi_30d: data?.result?.list?.[0]?.roi30days ? parseFloat(data.result.list[0].roi30days) : null,
      roi: data?.result?.list?.[0]?.roi ? parseFloat(data.result.list[0].roi) : null
    })
  },
  gateio: {
    baseUrl: 'https://www.gate.com/api/futures_copy/copy_trader/detail',
    periods: { 'period=7': '7d', 'period=30': '30d' },
    parseResponse: (data) => ({
      roi_7d: data?.data?.roi_7d || null,
      roi_30d: data?.data?.roi_30d || null,
      roi: data?.data?.roi || null
    })
  }
  // ... 其他平台配置
}

async function fetchMultiPeriodROI(source, traderId) {
  const config = PLATFORMS[source]
  if (!config) {
    console.log(`No config for ${source}`)
    return null
  }

  try {
    // 根据平台配置抓取多时间段数据
    const results = {}
    for (const [param, period] of Object.entries(config.periods)) {
      const url = `${config.baseUrl}?traderId=${traderId}&${param}`
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Accept': 'application/json'
        }
      })
      if (res.ok) {
        const data = await res.json()
        results[period] = config.parseResponse(data)
      }
      await new Promise(r => setTimeout(r, 200)) // 避免限流
    }
    
    return results
  } catch (e) {
    console.error(`Error fetching ${source} ${traderId}:`, e.message)
    return null
  }
}

async function importTraderWithMultiPeriodROI(source, traderId, basicData) {
  // 1. 抓取三个时间段的 ROI
  const roiData = await fetchMultiPeriodROI(source, traderId)
  
  // 2. 合并到基本数据
  const snapshot = {
    ...basicData,
    roi: roiData?.all?.roi || basicData.roi,
    roi_7d: roiData?.['7d']?.roi_7d || null,
    roi_30d: roiData?.['30d']?.roi_30d || null,
    captured_at: new Date().toISOString()
  }
  
  // 3. 插入数据库
  const { error } = await sb.from('trader_snapshots').upsert(snapshot)
  if (error) {
    console.error('Insert error:', error.message)
    return false
  }
  
  console.log(`✅ Imported ${source} ${traderId}: ROI=${snapshot.roi?.toFixed(1)}% 7d=${snapshot.roi_7d?.toFixed(1)}% 30d=${snapshot.roi_30d?.toFixed(1)}%`)
  return true
}

// 批量导入示例
async function batchImport(source, traderIds) {
  console.log(`=== Importing ${traderIds.length} traders from ${source} ===`)
  
  let success = 0
  for (const id of traderIds) {
    // 获取基本数据 (从排行榜或其他来源)
    const basicData = {
      source,
      source_trader_id: id,
      // ... 其他字段
    }
    
    if (await importTraderWithMultiPeriodROI(source, id, basicData)) {
      success++
    }
    
    // 限流控制
    await new Promise(r => setTimeout(r, 500))
  }
  
  console.log(`\nDone: ${success}/${traderIds.length} imported`)
}

export { fetchMultiPeriodROI, importTraderWithMultiPeriodROI, batchImport }

/**
 * Binance Copy Trading 数据导入脚本 - 增强版
 * 
 * 功能：
 * 1. 抓取 90D 排行榜的 TOP 100 交易员
 * 2. 为每个交易员获取 7D、30D、90D 的 ROI 数据
 * 3. 存储到 trader_snapshots 表，包含所有时间段的数据
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const API_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'

// 获取单个交易员的详细数据（包括不同时间段的 ROI）
const DETAIL_API_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail'

async function main() {
  console.log('=== Binance Copy Trading 多时间段数据导入 ===')
  console.log('')

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )

    // 先访问页面获取 cookies
    console.log('访问币安页面...')
    await page.goto('https://www.binance.com/en/copy-trading', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    })
    await new Promise(resolve => setTimeout(resolve, 5000))

    // 1. 获取 90D 排行榜
    console.log('获取 90D 排行榜...')
    const traders90D = await fetchRankings(page, '90D')
    console.log(`90D 排行榜: ${traders90D.length} 人`)

    if (traders90D.length === 0) {
      throw new Error('无法获取 90D 排行榜数据')
    }

    // 2. 获取 7D 和 30D 的 ROI（只需要获取排行榜即可匹配）
    console.log('')
    console.log('获取 7D 排行榜...')
    const traders7D = await fetchRankings(page, '7D')
    console.log(`7D 排行榜: ${traders7D.length} 人`)

    console.log('')
    console.log('获取 30D 排行榜...')
    const traders30D = await fetchRankings(page, '30D')
    console.log(`30D 排行榜: ${traders30D.length} 人`)

    // 3. 合并数据：以 90D 排行榜为主，添加 7D 和 30D 数据
    console.log('')
    console.log('合并多时间段数据...')
    
    const traders7DMap = new Map(traders7D.map(t => [t.leadPortfolioId, t]))
    const traders30DMap = new Map(traders30D.map(t => [t.leadPortfolioId, t]))

    const mergedData = traders90D.map((trader90D, index) => {
      const trader7D = traders7DMap.get(trader90D.leadPortfolioId)
      const trader30D = traders30DMap.get(trader90D.leadPortfolioId)

      return {
        source: 'binance',
        source_trader_id: String(trader90D.leadPortfolioId),
        rank: index + 1,
        // 90D 数据（主数据）
        roi: Number(trader90D.roi) || 0,
        pnl: trader90D.pnl != null ? Number(trader90D.pnl) : null,
        win_rate: trader90D.winRate != null ? Number(trader90D.winRate) : null,
        max_drawdown: trader90D.mdd != null ? Number(trader90D.mdd) : null,
        // 7D 数据
        roi_7d: trader7D ? Number(trader7D.roi) : null,
        pnl_7d: trader7D?.pnl != null ? Number(trader7D.pnl) : null,
        win_rate_7d: trader7D?.winRate != null ? Number(trader7D.winRate) : null,
        max_drawdown_7d: trader7D?.mdd != null ? Number(trader7D.mdd) : null,
        // 30D 数据
        roi_30d: trader30D ? Number(trader30D.roi) : null,
        pnl_30d: trader30D?.pnl != null ? Number(trader30D.pnl) : null,
        win_rate_30d: trader30D?.winRate != null ? Number(trader30D.winRate) : null,
        max_drawdown_30d: trader30D?.mdd != null ? Number(trader30D.mdd) : null,
        // 其他
        followers: 0,
        season_id: '90D',
        captured_at: new Date().toISOString(),
        // 用于 trader_sources
        _nickname: trader90D.nickname,
        _avatarUrl: trader90D.avatarUrl,
      }
    })

    // 统计
    const has7D = mergedData.filter(t => t.roi_7d !== null).length
    const has30D = mergedData.filter(t => t.roi_30d !== null).length
    console.log(`有 7D 数据: ${has7D}/${mergedData.length}`)
    console.log(`有 30D 数据: ${has30D}/${mergedData.length}`)

    // 4. 保存到数据库
    console.log('')
    console.log('保存到数据库...')
    await saveToDatabase(mergedData)

    console.log('')
    console.log('✅ 导入完成！')

  } finally {
    await browser.close()
  }
}

async function fetchRankings(page, timeRange) {
  const requestBody = {
    pageNumber: 1,
    pageSize: 50,
    timeRange: timeRange,
    dataType: 'ROI',
    favoriteOnly: false,
    hideFull: false,
    nickname: '',
    order: 'DESC',
    userAsset: 0,
    portfolioType: 'ALL',
    useAiRecommended: false,
  }

  const allData = []

  // 获取前 2 页数据（共 100 条）
  for (let pageNum = 1; pageNum <= 2; pageNum++) {
    const pageRequestBody = { ...requestBody, pageNumber: pageNum }
    
    const data = await page.evaluate(async (url, body) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
        
        if (!response.ok) {
          return { error: `HTTP ${response.status}` }
        }
        
        return await response.json()
      } catch (error) {
        return { error: error.message }
      }
    }, API_URL, pageRequestBody)

    if (data.error) {
      console.warn(`  第 ${pageNum} 页获取失败: ${data.error}`)
      continue
    }

    if (data.code === '000000' && data.data?.list) {
      allData.push(...data.data.list)
    }

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  return allData.slice(0, 100)
}

async function saveToDatabase(mergedData) {
  // 保存 trader_sources
  const sourcesData = mergedData.map(item => ({
    source: 'binance',
    source_type: 'leaderboard',
    source_trader_id: item.source_trader_id,
    handle: item._nickname && item._nickname.trim() !== '' ? item._nickname : null,
    profile_url: item._avatarUrl || null,
    is_active: true,
    market_type: 'futures',
    source_kind: 'public',
    identity_type: 'trader',
  }))

  console.log(`  保存 trader_sources: ${sourcesData.length} 条`)
  const { error: sourcesError } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, {
      onConflict: 'source,source_trader_id',
      ignoreDuplicates: false,
    })

  if (sourcesError) {
    console.error('  ✗ trader_sources 保存失败:', sourcesError.message)
  } else {
    console.log('  ✓ trader_sources 保存成功')
  }

  // 保存 trader_snapshots（移除临时字段）
  const snapshotsData = mergedData.map(item => {
    const { _nickname, _avatarUrl, ...snapshot } = item
    return snapshot
  })

  console.log(`  保存 trader_snapshots: ${snapshotsData.length} 条`)
  const { error: snapshotsError } = await supabase
    .from('trader_snapshots')
    .upsert(snapshotsData, {
      onConflict: 'source,source_trader_id,captured_at',
      ignoreDuplicates: false,
    })

  if (snapshotsError) {
    console.error('  ✗ trader_snapshots 保存失败:', snapshotsError.message)
    // 如果是列不存在的错误，提示运行 SQL
    if (snapshotsError.message?.includes('column') || snapshotsError.code === '42703') {
      console.log('')
      console.log('💡 提示：请先在 Supabase 中运行 scripts/add_multi_period_roi.sql 添加新列')
    }
  } else {
    console.log('  ✓ trader_snapshots 保存成功')
  }
}

main().catch(error => {
  console.error('导入失败:', error)
  process.exit(1)
})


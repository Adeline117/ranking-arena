import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'fs'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const API_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
const PAGE_SIZE = 50 // 每页大小

// 从命令行参数获取时间段，默认为 90D
const timeRange = process.argv[2] || '90D'
const validTimeRanges = ['7D', '30D', '90D']
if (!validTimeRanges.includes(timeRange)) {
  console.error(`错误: 无效的时间段 ${timeRange}，有效值: ${validTimeRanges.join(', ')}`)
  process.exit(1)
}

/**
 * 标准化数据格式
 */
function normalizeData(rawData, currentTimeRange) {
  if (!Array.isArray(rawData)) {
    throw new Error('数据必须是数组格式')
  }

  return rawData.map((item) => {
    const traderId = item.leadPortfolioId
    const handle = item.nickname || null
    
    // roi 字段根据时间段不同（7D、30D、90D）
    const roi = item.roi != null ? Number(item.roi) : 0
    
    // PnL 字段
    const pnl = item.pnl != null ? Number(item.pnl) : null
    
    // 注意：不再获取 followers，因为所有 trader 的粉丝数只能来源 Arena 注册用户的关注
    // const followers = item.currentCopyCount || 0
    
    // 头像
    const avatarUrl = item.avatarUrl || null

    // 胜率
    const winRate = item.winRate != null ? Number(item.winRate) : null

    // 多时间段ROI（如果API提供）
    const roi_7d = item.roi7d != null ? Number(item.roi7d) : (item.roi_7d != null ? Number(item.roi_7d) : null)
    const roi_30d = item.roi30d != null ? Number(item.roi30d) : (item.roi_30d != null ? Number(item.roi_30d) : null)
    const roi_1y = item.roi1y != null ? Number(item.roi1y) : (item.roi_1y != null ? Number(item.roi_1y) : null)
    const roi_2y = item.roi2y != null ? Number(item.roi2y) : (item.roi_2y != null ? Number(item.roi_2y) : null)

    // 交易统计（如果API提供）
    const totalTrades = item.totalTrades != null ? Number(item.totalTrades) : (item.total_trades != null ? Number(item.total_trades) : null)
    const avgProfit = item.avgProfit != null ? Number(item.avgProfit) : (item.avg_profit != null ? Number(item.avg_profit) : null)
    const avgLoss = item.avgLoss != null ? Number(item.avgLoss) : (item.avg_loss != null ? Number(item.avg_loss) : null)
    const profitableTradesPct = item.profitableTradesPct != null ? Number(item.profitableTradesPct) : (item.profitable_trades_pct != null ? Number(item.profitable_trades_pct) : null)

    return {
      encryptedUid: String(traderId),
      nickName: handle,
      roi: roi,
      pnl: pnl,
      followerCount: null, // 已废弃，不再从交易所 API 获取
      userPhotoUrl: avatarUrl,
      winRate: winRate,
      roi_7d: isNaN(roi_7d) ? null : roi_7d,
      roi_30d: isNaN(roi_30d) ? null : roi_30d,
      roi_1y: isNaN(roi_1y) ? null : roi_1y,
      roi_2y: isNaN(roi_2y) ? null : roi_2y,
      totalTrades: totalTrades,
      avgProfit: avgProfit,
      avgLoss: avgLoss,
      profitableTradesPct: profitableTradesPct,
      _raw: item,
    }
  })
}

/**
 * 使用 Puppeteer 获取所有页面的数据
 */
async function fetchAllPages(timeRangeParam) {
  console.log(`=== 币安 ${timeRangeParam} ROI排行榜数据抓取 ===`)
  console.log('')
  console.log('正在启动浏览器...')
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const page = await browser.newPage()
  
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  // 监听网络请求，捕获API调用
  let capturedRequests = []
  let capturedData = null
  
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('query-list')) {
      const method = request.method()
      const postData = request.postData()
      console.log(`捕获到请求: ${method} ${url}`)
      if (postData) {
        console.log(`  请求体: ${postData}`)
      }
      capturedRequests.push({ url, method, postData })
    }
  })
  
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('query-list')) {
      try {
        const data = await response.json()
        if (data.code === '000000' && data.data) {
          capturedData = data
          console.log(`✓ 捕获到API响应: ${data.data.list?.length || 0} 条数据，总计: ${data.data.total || 0}`)
        }
      } catch (e) {
        // 忽略
      }
    }
  })
  
  // 先访问币安页面
  console.log('访问币安页面...')
  await page.goto('https://www.binance.com/en/copy-trading', {
    waitUntil: 'networkidle2',
    timeout: 60000,
  })
  
  console.log('等待页面加载和API调用...')
  await new Promise(resolve => setTimeout(resolve, 8000))
  
  // 分析捕获到的请求参数
  let requestParams = null
  if (capturedRequests.length > 0 && capturedRequests[0].postData) {
    try {
      requestParams = JSON.parse(capturedRequests[0].postData)
      console.log('分析捕获到的请求参数:', JSON.stringify(requestParams, null, 2))
    } catch (e) {
      // 忽略
    }
  }
  
  // 构建请求参数
  const requestBody = {
    pageNumber: 1,
    pageSize: 50,
    timeRange: timeRangeParam,  // 时间段: 7D, 30D, 90D
    dataType: 'ROI',    // ROI类型
    favoriteOnly: false,
    hideFull: false,
    nickname: '',
    order: 'DESC',      // 降序
    userAsset: 0,
    portfolioType: 'ALL',
    useAiRecommended: false,
  }
  
  console.log(`使用 ${timeRangeParam} ROI参数获取数据...`)
  console.log('请求参数:', JSON.stringify(requestBody, null, 2))
  console.log('')
  
  // 在页面中调用API获取第一页
  const firstPageData = await page.evaluate(async (url, body) => {
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
        const text = await response.text()
        return { error: `HTTP ${response.status}: ${text.substring(0, 200)}` }
      }
      
      return await response.json()
    } catch (error) {
      return { error: error.message }
    }
  }, API_URL, requestBody)
  
  if (firstPageData.error) {
    await browser.close()
    throw new Error(`获取第一页失败: ${firstPageData.error}`)
  }
  
  if (firstPageData.code !== '000000') {
    await browser.close()
    throw new Error(`API错误: ${firstPageData.message || firstPageData.code}`)
  }
  
  const total = firstPageData.data?.total || 0
  const firstPageList = firstPageData.data?.list || []
  
  console.log(`总交易员数: ${total}`)
  console.log(`第一页数据: ${firstPageList.length} 条`)
  
  // 验证数据：检查"大夫"的ROI
  const doctor = firstPageList.find(d => d.nickname === '大夫')
  if (doctor) {
    console.log(`验证: "大夫"的ROI = ${doctor.roi}%`)
  }
  console.log('')
  
  // 计算需要获取的页数（为了确保能获取到Top 100，获取足够的数据）
  const pagesToFetch = Math.min(Math.ceil(200 / requestBody.pageSize), Math.ceil(total / requestBody.pageSize))
  console.log(`需要获取 ${pagesToFetch} 页数据（用于筛选Top 100）`)
  console.log('')
  
  // 收集所有数据
  let allData = [...firstPageList]
  
  // 获取剩余页面
  for (let pageNum = 2; pageNum <= pagesToFetch; pageNum++) {
    console.log(`获取第 ${pageNum}/${pagesToFetch} 页...`)
    
    try {
      // 使用正确的参数格式
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
          console.warn(`  ✗ 第 ${pageNum} 页获取失败: ${data.error}`)
          continue
        }
        
        if (data.code === '000000' && data.data?.list) {
          allData.push(...data.data.list)
          console.log(`  ✓ 获取 ${data.data.list.length} 条数据`)
        } else {
          console.warn(`  ✗ 第 ${pageNum} 页数据格式异常: ${data.message || data.code}`)
        }
        
      // 延迟避免请求过快
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch (error) {
      console.warn(`  ✗ 第 ${pageNum} 页获取失败: ${error.message}`)
    }
  }
  
  await browser.close()
  
  console.log('')
  console.log(`共获取 ${allData.length} 条数据`)
  console.log('')
  
  return allData
}

/**
 * 导入数据到 Supabase
 */
async function importToSupabase(normalizedData, sourceType = 'binance', timeRangeParam = '90D') {
  // 过滤并排序：只保留有效的 ROI 数据，只保留前 100 条
  const validData = normalizedData
    .filter(item => {
      const roi = item.roi
      return roi != null && !isNaN(Number(roi)) && Number(roi) !== 0 && isFinite(Number(roi))
    })
    .sort((a, b) => Number(b.roi) - Number(a.roi))
    .slice(0, 100) // 只保留 ROI 前 100

  console.log(`筛选后条数（ROI Top 100）: ${validData.length}`)

  if (validData.length === 0) {
    console.error('没有有效的数据可导入')
    return
  }

  // 输出前10条数据用于调试
  console.log('ROI 最高的 10 条数据:')
  validData.slice(0, 10).forEach((item, idx) => {
    console.log(`  ${idx + 1}. ROI: ${item.roi.toFixed(2)}%, PnL: ${item.pnl || 'N/A'}, Handle: ${item.nickName || item.encryptedUid}`)
  })
  console.log('')

  // 使用统一的 captured_at 时间戳
  // 这样可以在内存中 merge 完所有周期后再 upsert，提高稳定性
  // 注意：如果数据库中有 run_id 列，可以添加 run_id 来追踪每次抓取批次
  const capturedAt = new Date().toISOString()
  
  console.log(`统一 captured_at: ${capturedAt}`)
  console.log('')

  // 在内存中 merge 数据：按 source_trader_id 合并，保留最新数据
  const mergedDataMap = new Map()
  validData.forEach(item => {
    const key = `${sourceType}_${item.encryptedUid}`
    const existing = mergedDataMap.get(key)
    // 如果已存在，保留 ROI 更高的记录（或者可以根据其他逻辑选择）
    if (!existing || Number(item.roi) > Number(existing.roi)) {
      mergedDataMap.set(key, item)
    }
  })
  const mergedData = Array.from(mergedDataMap.values())
  
  console.log(`Merge 后数据量: ${mergedData.length} (原始: ${validData.length})`)
  console.log('')

  const sourcesData = mergedData.map(item => ({
    source: sourceType,
    source_type: 'leaderboard',
    source_trader_id: item.encryptedUid,
    handle: item.nickName && item.nickName.trim() !== '' ? item.nickName : null,
    profile_url: item.userPhotoUrl || null,
    is_active: true,
    market_type: 'futures',
    source_kind: 'public',
    identity_type: 'trader',
  }))

  // 重新排序合并后的数据
  const sortedMergedData = mergedData
    .sort((a, b) => Number(b.roi) - Number(a.roi))
    .slice(0, 100) // 确保不超过 Top 100

  // 使用数据库中存在的所有列：
  // captured_at, followers, holding_days, max_drawdown, pnl, rank, roi, season_id, source, source_trader_id, trades_count, win_rate
  // 使用 season_id 存储时间段：'7D', '30D', '90D'
  const snapshotsData = sortedMergedData.map((item, index) => {
    const rawData = item._raw || {}
    return {
      source: sourceType,
      source_trader_id: item.encryptedUid,
      rank: index + 1,
      roi: Number(item.roi), // 当前时间段的 ROI
      pnl: item.pnl != null ? Number(item.pnl) : null,
      win_rate: item.winRate != null ? Number(item.winRate) : null,
      max_drawdown: rawData.mdd != null ? Number(rawData.mdd) : null, // 最大回撤
      followers: 0, // 设置为 0，实际粉丝数从 Arena 用户关注统计
      season_id: timeRangeParam, // 存储时间段：'7D', '30D', '90D'
      captured_at: capturedAt,
    }
  })

  const BATCH_SIZE = 100
  let sourcesSuccess = 0
  let snapshotsSuccess = 0

  // 去重 trader_sources
  const uniqueSources = new Map()
  sourcesData.forEach(item => {
    const key = `${item.source}_${item.source_type}_${item.source_trader_id}`
    if (!uniqueSources.has(key)) {
      uniqueSources.set(key, item)
    }
  })
  const uniqueSourcesData = Array.from(uniqueSources.values())

  console.log('导入 trader_sources...')
  for (let i = 0; i < uniqueSourcesData.length; i += BATCH_SIZE) {
    const batch = uniqueSourcesData.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_sources')
      .upsert(batch, { onConflict: 'source,source_type,source_trader_id' })

    if (error) {
      console.error(`trader_sources 批次 ${Math.floor(i / BATCH_SIZE) + 1} 错误:`, error.message)
    } else {
      sourcesSuccess += batch.length
      console.log(`✓ trader_sources 批次 ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} 条`)
    }
  }

  console.log('')
  console.log('导入 trader_snapshots...')
  // 对于多时间段数据，我们使用 insert 插入新记录
  // 查询时会使用最新的 captured_at 记录，该记录包含对应时间段的 ROI
  // 如果需要合并多个时间段，可以在查询时合并多个记录
  for (let i = 0; i < snapshotsData.length; i += BATCH_SIZE) {
    const batch = snapshotsData.slice(i, i + BATCH_SIZE)
    
    // 使用 insert 插入新记录（每个时间段一个记录）
    // 注意：由于不同时间段的 captured_at 可能不同，每个时间段会创建单独的记录
    // 查询时使用 order('captured_at', { ascending: false }).limit(1) 获取最新记录
    const { error } = await supabase
      .from('trader_snapshots')
      .insert(batch)

    if (error) {
      console.error(`trader_snapshots 批次 ${Math.floor(i / BATCH_SIZE) + 1} 错误:`, error.message)
    } else {
      snapshotsSuccess += batch.length
      console.log(`✓ trader_snapshots 批次 ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} 条`)
    }
  }

  console.log('')
  console.log(`✅ trader_sources: ${sourcesSuccess} 条`)
  console.log(`✅ trader_snapshots: ${snapshotsSuccess} 条`)
  console.log(`✅ 完成！共导入 ${sortedMergedData.length} 条币安跟单交易数据（${timeRangeParam} ROI Top 100）`)
  console.log(`✅ 统一 captured_at: ${capturedAt}`)
}

/**
 * 主函数
 */
async function main() {
  try {
    console.log(`时间段: ${timeRange}`)
    console.log('')
    
    // 获取所有数据
    const rawData = await fetchAllPages(timeRange)
    
    // 保存原始数据
    const outputPath = `binance_copy_trading_${timeRange.toLowerCase()}_${Date.now()}.json`
    writeFileSync(outputPath, JSON.stringify(rawData, null, 2))
    console.log(`原始数据已保存到: ${outputPath}`)
    console.log('')
    
    // 标准化数据
    console.log('标准化数据...')
    const normalizedData = normalizeData(rawData, timeRange)
    console.log(`✓ 标准化后: ${normalizedData.length} 条`)
    console.log('')

    // 导入到 Supabase
    console.log('导入到 Supabase...')
    await importToSupabase(normalizedData, 'binance', timeRange)
    
    console.log('')
    console.log(`✅ 全部完成！(${timeRange})`)
  } catch (error) {
    console.error('执行失败:', error)
    process.exit(1)
  }
}

main()


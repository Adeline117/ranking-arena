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

/**
 * 标准化数据格式
 */
function normalizeData(rawData) {
  if (!Array.isArray(rawData)) {
    throw new Error('数据必须是数组格式')
  }

  return rawData.map((item, index) => {
    const traderId = item.leadPortfolioId || item.uid || item.userId || item.traderId || item.encryptedUid || item.id || String(index)
    const handle = item.nickname || item.nickName || item.name || item.username || item.handle || null
    
    // 币安跟单交易页面的 ROI 字段
    // 从图片描述看，ROI 应该是 "90天收益率"，可能是百分比形式
    // 需要检查实际数据格式
    let roi = 0
    
    // 尝试多种可能的 ROI 字段
    if (item.roi90d !== undefined && item.roi90d !== null) {
      roi = Number(item.roi90d)
    } else if (item.roi90D !== undefined && item.roi90D !== null) {
      roi = Number(item.roi90D)
    } else if (item.roi !== undefined && item.roi !== null) {
      roi = Number(item.roi)
    } else if (item.return90d !== undefined && item.return90d !== null) {
      roi = Number(item.return90d)
    } else if (item.returnRate90d !== undefined && item.returnRate90d !== null) {
      roi = Number(item.returnRate90d)
    } else if (item.performance90d !== undefined && item.performance90d !== null) {
      roi = Number(item.performance90d)
    }
    
    // 如果 ROI 是小数形式（如 0.8624），需要转换为百分比（86.24%）
    // 如果 ROI 已经是百分比形式（如 8624.66），直接使用
    // 从图片看，"大夫"的 ROI 是 8,624.66%，所以应该是百分比形式
    // 但如果数据是 86.2466，需要乘以 100
    
    // PnL 字段
    const pnl = item.pnl90d || item.pnl90D || item.pnl || 
                item.profit90d || item.profit90D || item.profit || 
                item.realizedPnl || item.realizedPnl90d || null
    
    // 关注者
    const followers = item.currentCopyCount || item.followerCount || item.followers || item.copiers || item.copyCount || 0
    
    // 头像
    const avatarUrl = item.avatarUrl || item.avatar || item.userPhotoUrl || item.profilePicture || null

    // 胜率
    const winRate = item.winRate90d || item.winRate90D || item.winRate || item.winningRate || null

    return {
      encryptedUid: String(traderId),
      nickName: handle,
      roi: roi,
      pnl: pnl != null ? Number(pnl) : null,
      followerCount: Number(followers),
      userPhotoUrl: avatarUrl,
      winRate: winRate != null ? Number(winRate) : null,
      _raw: item, // 保留原始数据用于调试
    }
  })
}

/**
 * 导入数据到 Supabase
 */
async function importToSupabase(normalizedData, sourceType = 'binance') {
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
    if (item._raw) {
      console.log(`      原始数据 ROI 字段:`, {
        roi: item._raw.roi,
        roi90d: item._raw.roi90d,
        return90d: item._raw.return90d,
        returnRate90d: item._raw.returnRate90d,
        performance90d: item._raw.performance90d,
      })
    }
  })

  const capturedAt = new Date().toISOString()

  const sourcesData = validData.map(item => ({
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

  const snapshotsData = validData.map((item, index) => ({
    source: sourceType,
    source_trader_id: item.encryptedUid,
    rank: index + 1,
    roi: Number(item.roi),
    pnl: item.pnl != null ? Number(item.pnl) : null,
    followers: item.followerCount != null ? Number(item.followerCount) : null,
    captured_at: capturedAt,
  }))

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

  console.log('')
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
  for (let i = 0; i < snapshotsData.length; i += BATCH_SIZE) {
    const batch = snapshotsData.slice(i, i + BATCH_SIZE)
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
  console.log(`✅ 完成！共导入 ${validData.length} 条币安跟单交易数据（ROI Top 100）`)
}

/**
 * 使用 Puppeteer 抓取数据
 */
async function scrapeWithPuppeteer() {
  console.log('=== 币安跟单交易数据抓取工具 v2 ===')
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

  // 存储找到的 API 数据
  const allApiData = []
  const apiUrls = []

  // 监听所有网络请求
  page.on('response', async (response) => {
    const url = response.url()
    
    // 检查是否是跟单交易相关的 API
    if ((url.includes('copy-trading') || url.includes('copy-trade') || url.includes('leaderboard') || url.includes('trader') || 
         url.includes('copytrader') || url.includes('futures') || url.includes('apex')) && 
        (url.includes('bapi') || url.includes('api') || url.includes('fapi'))) {
      
      try {
        const data = await response.json()
        
        // 检查响应格式
        let dataArray = null
        
        if (data.code === '000000' && data.data) {
          dataArray = Array.isArray(data.data) ? data.data : (data.data.data || data.data.list || [])
        } else if (Array.isArray(data)) {
          dataArray = data
        } else if (data.data && Array.isArray(data.data)) {
          dataArray = data.data
        }
        
        if (dataArray && dataArray.length > 0) {
          // 检查是否包含 ROI 相关字段
          const sample = dataArray[0]
          const hasRoi = sample.roi90d || sample.roi90D || sample.roi || 
                        sample.return90d || sample.return90D || sample.returnRate90d ||
                        sample.performance90d || sample.performance90D ||
                        sample.leadPortfolioId // 币安跟单交易的特征字段
          
          if (hasRoi) {
            console.log('')
            console.log('✅ 找到包含 ROI 数据的 API:')
            console.log(`   URL: ${url}`)
            console.log(`   数据条数: ${dataArray.length}`)
            
            // 输出第一条数据的详细信息用于调试
            if (dataArray[0]) {
              console.log(`   示例数据字段:`, Object.keys(dataArray[0]).slice(0, 15))
              console.log(`   示例 ROI 相关字段:`, {
                roi: dataArray[0].roi,
                roi90d: dataArray[0].roi90d,
                return90d: dataArray[0].return90d,
                returnRate90d: dataArray[0].returnRate90d,
                performance90d: dataArray[0].performance90d,
                pnl: dataArray[0].pnl,
                pnl90d: dataArray[0].pnl90d,
              })
            }
            
            allApiData.push(...dataArray)
            apiUrls.push(url)
          }
        }
      } catch (error) {
        // 忽略非 JSON 响应
      }
    }
  })

  const targetUrl = 'https://www.binance.com/en/copy-trading'
  console.log(`正在访问: ${targetUrl}`)
  console.log('')
  
  try {
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    })
    
    // 等待一段时间，确保所有请求都完成
    console.log('等待网络请求完成...')
    await new Promise(resolve => setTimeout(resolve, 10000))
    
    // 尝试滚动页面触发更多请求
    if (allApiData.length < 50) {
      console.log('尝试滚动页面以触发更多请求...')
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
      })
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
    
  } catch (error) {
    console.error('访问页面失败:', error.message)
  }

  await browser.close()

  // 去重（基于 leadPortfolioId 或 uid）
  const uniqueData = []
  const seenIds = new Set()
  for (const item of allApiData) {
    const id = item.leadPortfolioId || item.uid || item.userId || item.traderId || item.encryptedUid
    if (id && !seenIds.has(String(id))) {
      seenIds.add(String(id))
      uniqueData.push(item)
    }
  }

  if (uniqueData.length === 0) {
    console.log('')
    console.error('❌ 未找到数据')
    process.exit(1)
  }

  // 保存原始数据
  const outputPath = `binance_copy_trading_scraped_v2_${Date.now()}.json`
  writeFileSync(outputPath, JSON.stringify(uniqueData, null, 2))
  console.log(`原始数据已保存到: ${outputPath}`)
  console.log(`共找到 ${uniqueData.length} 条唯一数据`)
  console.log('')

  return uniqueData
}

/**
 * 主函数
 */
async function main() {
  try {
    // 抓取数据
    const rawData = await scrapeWithPuppeteer()
    
    // 标准化数据
    console.log('标准化数据...')
    const normalizedData = normalizeData(rawData)
    console.log(`✓ 标准化后: ${normalizedData.length} 条`)
    console.log('')

    // 导入到 Supabase
    console.log('导入到 Supabase...')
    await importToSupabase(normalizedData, 'binance')
    
    console.log('')
    console.log('✅ 全部完成！')
  } catch (error) {
    console.error('执行失败:', error)
    process.exit(1)
  }
}

main()



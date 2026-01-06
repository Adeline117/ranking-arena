import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer'
import { writeFileSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 加载 .env 文件
try {
  const envPath = join(__dirname, '..', '.env')
  const envContent = readFileSync(envPath, 'utf-8')
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=')
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '')
      if (!process.env[key.trim()]) {
        process.env[key.trim()] = value
      }
    }
  })
} catch (e) {
  // .env 文件不存在或无法读取，继续使用环境变量
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/**
 * 从网络请求中提取 API URL
 */
async function findApiUrl(page) {
  return new Promise((resolve) => {
    const apiUrls = []
    let resolved = false
    
    const checkResponse = async (response) => {
      const url = response.url()
      if ((url.includes('leaderboard') || url.includes('bapi') || url.includes('web3')) && !resolved) {
        try {
          const data = await response.json()
          if (data.code === '000000' && data.data && data.data.data && Array.isArray(data.data.data)) {
            const urlObj = new URL(url)
            const baseUrl = urlObj.origin + urlObj.pathname
            apiUrls.push({
              url: baseUrl,
              fullUrl: url,
              pages: data.data.pages,
              params: Object.fromEntries(urlObj.searchParams),
            })
            if (!resolved) {
              resolved = true
              resolve(apiUrls[0])
            }
          }
        } catch (e) {
          // 忽略非 JSON 响应
        }
      }
    }
    
    page.on('response', checkResponse)
    
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        resolve(apiUrls.length > 0 ? apiUrls[0] : null)
      }
    }, 10000)
  })
}

/**
 * 使用 Puppeteer 抓取数据
 */
async function scrapeWithPuppeteer() {
  console.log('启动浏览器...')
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const page = await browser.newPage()
  
  // 设置 User-Agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  // 先设置响应监听器
  console.log('设置网络请求监听...')
  const apiInfoPromise = findApiUrl(page)
  
  console.log('访问 Binance Web3 Leaderboard...')
  await page.goto('https://web3.binance.com/en/leaderboard?chain=bsc', {
    waitUntil: 'networkidle2',
    timeout: 60000,
  })

  // 等待页面加载和 API 调用
  console.log('等待 API 响应...')
  await new Promise(resolve => setTimeout(resolve, 5000))

  // 获取找到的 API 信息
  const apiInfo = await apiInfoPromise
  
  let allData = []
  
  if (apiInfo) {
    console.log(`找到 API: ${apiInfo.url}`)
    console.log(`总页数: ${apiInfo.pages}`)
    
    // 使用找到的 API 获取所有页面
    const baseUrl = apiInfo.url
    const originalParams = apiInfo.params || {}
    
    for (let pageNum = 1; pageNum <= apiInfo.pages; pageNum++) {
      const params = new URLSearchParams(originalParams)
      params.set('page', pageNum)
      if (!params.has('size')) {
        params.set('size', '25')
      }
      
      const apiUrl = `${baseUrl}?${params.toString()}`
      console.log(`获取第 ${pageNum}/${apiInfo.pages} 页...`)
      
      try {
        const response = await page.evaluate(async (url) => {
          const res = await fetch(url, {
            headers: {
              'Accept': 'application/json',
              'Referer': 'https://web3.binance.com/',
              'Origin': 'https://web3.binance.com',
            },
          })
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`)
          }
          return res.json()
        }, apiUrl)
        
        if (response.code === '000000' && response.data && response.data.data) {
          allData.push(...response.data.data)
          console.log(`✓ 第 ${pageNum} 页: ${response.data.data.length} 条数据`)
        } else {
          console.log(`✗ 第 ${pageNum} 页: 数据格式不正确`)
        }
        
        // 延迟避免限流
        await new Promise(resolve => setTimeout(resolve, 500))
      } catch (error) {
        console.error(`✗ 第 ${pageNum} 页失败:`, error.message)
      }
    }
  } else {
    // 如果找不到 API，尝试从页面中提取数据
    console.log('未找到 API，尝试从页面提取数据...')
    
    // 滚动页面加载更多数据
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    
    // 尝试从页面中提取数据
    const pageData = await page.evaluate(() => {
      // 查找可能的 JSON 数据
      if (window.__NEXT_DATA__) {
        return window.__NEXT_DATA__
      }
      return null
    })
    
    if (pageData && pageData.props?.pageProps) {
      // 尝试提取数据
      console.log('从页面数据中提取...')
    }
  }

  await browser.close()
  
  if (allData.length === 0) {
    throw new Error('未能获取到数据')
  }
  
  return allData
}

/**
 * 标准化数据格式
 */
function normalizeData(rawData) {
  return rawData.map((item, index) => {
    const traderId = item.address || item.encryptedUid || item.uid || item.walletAddress || item.userId || String(item.id || index)
    const handle = item.addressLabel || item.nickName || item.nickname || item.name || item.username || item.handle || null
    const roiPercent = item.realizedPnlPercent != null ? Number(item.realizedPnlPercent) * 100 : null
    const roi = roiPercent || Number(item.roi || item.returnRate || item.return || item.performance || item.profit || 0)
    const pnl = item.realizedPnl != null ? Number(item.realizedPnl) : (item.pnl != null ? Number(item.pnl) : (item.profit != null ? Number(item.profit) : null))
    const followers = item.followerCount != null ? Number(item.followerCount) : (item.followers != null ? Number(item.followers) : null)
    const avatarUrl = item.addressLogo || item.userPhotoUrl || item.avatar || item.avatarUrl || item.profilePicture || null
    
    const winRate = item.winRate != null ? Number(item.winRate) : null
    const totalVolume = item.totalVolume != null ? Number(item.totalVolume) : null
    const avgBuyVolume = item.avgBuyVolume != null ? Number(item.avgBuyVolume) : null
    const lastActivity = item.lastActivity != null ? new Date(item.lastActivity).toISOString() : null

    return {
      encryptedUid: traderId,
      nickName: handle,
      roi: roi,
      pnl: pnl,
      followerCount: followers,
      userPhotoUrl: avatarUrl,
      winRate: winRate,
      volume_90d: totalVolume,
      avg_buy_90d: avgBuyVolume,
      lastActivity: lastActivity,
      _raw: item,
    }
  })
}

/**
 * 导入数据到 Supabase
 */
async function importToSupabase(normalizedData, sourceType = 'binance_web3') {
  const validData = normalizedData
    .filter(item => {
      const roi = item.roi
      return roi != null && !isNaN(Number(roi)) && Number(roi) !== 0
    })
    .sort((a, b) => Number(b.roi) - Number(a.roi))

  console.log(`筛选后条数: ${validData.length}`)

  if (validData.length === 0) {
    console.error('没有有效的数据可导入')
    return
  }

  const capturedAt = new Date().toISOString()

  const sourcesData = validData.map(item => ({
    source: sourceType,
    source_type: 'leaderboard',
    source_trader_id: item.encryptedUid,
    handle: item.nickName || null,
    profile_url: item.userPhotoUrl || null,
    is_active: true,
    market_type: 'web3',
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
    win_rate: item.winRate != null ? Number(item.winRate) : null,
    volume_90d: item.volume_90d != null ? Number(item.volume_90d) : null,
    avg_buy_90d: item.avg_buy_90d != null ? Number(item.avg_buy_90d) : null,
    captured_at: capturedAt,
  }))

  // 分批写入
  const BATCH_SIZE = 100
  let sourcesSuccess = 0
  let snapshotsSuccess = 0

  for (let i = 0; i < sourcesData.length; i += BATCH_SIZE) {
    const batch = sourcesData.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_sources')
      .upsert(batch, { onConflict: 'source,source_type,source_trader_id' })

    if (error) {
      console.error(`trader_sources 批次 ${Math.floor(i / BATCH_SIZE) + 1} 错误:`, error.message)
    } else {
      sourcesSuccess += batch.length
    }
  }

  for (let i = 0; i < snapshotsData.length; i += BATCH_SIZE) {
    const batch = snapshotsData.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_snapshots')
      .insert(batch)

    if (error) {
      console.error(`trader_snapshots 批次 ${Math.floor(i / BATCH_SIZE) + 1} 错误:`, error.message)
    } else {
      snapshotsSuccess += batch.length
    }
  }

  console.log(`✓ trader_sources: ${sourcesSuccess} 条`)
  console.log(`✓ trader_snapshots: ${snapshotsSuccess} 条`)
  console.log(`完成！共导入 ${validData.length} 条数据`)
}

/**
 * 主函数
 */
async function main() {
  console.log('=== Binance Web3 Leaderboard 数据抓取工具 ===')
  console.log('')
  
  try {
    // 抓取数据
    const rawData = await scrapeWithPuppeteer()
    
    console.log('')
    console.log(`✓ 抓取完成，共 ${rawData.length} 条数据`)
    
    // 保存到文件
    const outputPath = `binance_web3_scraped_${Date.now()}.json`
    writeFileSync(outputPath, JSON.stringify(rawData, null, 2))
    console.log(`数据已保存到: ${outputPath}`)
    console.log('')
    
    // 标准化数据
    console.log('标准化数据...')
    const normalizedData = normalizeData(rawData)
    console.log(`标准化后: ${normalizedData.length} 条`)
    console.log('')
    
    // 导入到 Supabase
    console.log('导入到 Supabase...')
    await importToSupabase(normalizedData, 'binance_web3')
    
    console.log('')
    console.log('✅ 全部完成！')
  } catch (error) {
    console.error('❌ 抓取失败:', error.message)
    process.exit(1)
  }
}

main()


import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/**
 * 方法1: 尝试从 Binance Web3 API 获取数据
 * 注意：Binance Web3 可能没有公开的 API，这个方法可能不工作
 */
async function fetchFromBinanceWeb3API(chain = 'bsc', limit = 100) {
  try {
    // 可能的 API 端点（需要验证）
    const apiEndpoints = [
      `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query`,
      `https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank`,
      // Web3 特定的端点（需要实际测试）
      `https://www.binance.com/bapi/web3/v1/public/leaderboard?chain=${chain}&limit=${limit}`,
    ]

    for (const url of apiEndpoints) {
      try {
        console.log(`尝试 API: ${url}`)
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        })

        if (response.ok) {
          const data = await response.json()
          console.log('API 响应示例:', JSON.stringify(data, null, 2).slice(0, 500))
          
          // Binance Web3 API 格式: { code: "000000", data: { data: [...], pages: 36, size: 25, current: 1 } }
          if (data.code === '000000' && data.data && data.data.data && Array.isArray(data.data.data)) {
            console.log(`获取到 ${data.data.data.length} 条数据（第 ${data.data.current}/${data.data.pages} 页）`)
            return data.data.data
          } else if (data.data && Array.isArray(data.data)) {
            return data.data
          } else if (data.result && Array.isArray(data.result)) {
            return data.result
          } else if (Array.isArray(data)) {
            return data
          }
        }
      } catch (error) {
        console.log(`API ${url} 失败:`, error.message)
        continue
      }
    }

    throw new Error('所有 API 端点都失败')
  } catch (error) {
    console.error('从 API 获取数据失败:', error.message)
    return null
  }
}

/**
 * 方法2: 使用 Puppeteer 爬取网页数据
 * 需要安装: npm install puppeteer
 */
async function fetchFromWebPage(chain = 'bsc', limit = 100) {
  try {
    // 动态导入 puppeteer（如果已安装）
    const puppeteer = await import('puppeteer').catch(() => null)
    
    if (!puppeteer) {
      console.log('Puppeteer 未安装，跳过网页爬取')
      console.log('安装方法: npm install puppeteer')
      return null
    }

    console.log('启动浏览器...')
    const browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    const page = await browser.newPage()
    
    // 设置 User-Agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )

    const url = `https://web3.binance.com/en/leaderboard?chain=${chain}`
    console.log(`访问: ${url}`)
    
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    })

    // 等待排行榜数据加载
    await page.waitForTimeout(3000)

    // 尝试从页面中提取数据
    // 方法1: 查找网络请求中的 API 响应
    const apiData = await page.evaluate(() => {
      // 查找 window 对象中的数据
      if (window.__NEXT_DATA__) {
        return window.__NEXT_DATA__
      }
      // 查找其他可能的数据源
      return null
    })

    if (apiData) {
      console.log('从页面提取到数据')
      await browser.close()
      
      // 解析 Next.js 数据
      if (apiData.props?.pageProps?.leaderboard) {
        return apiData.props.pageProps.leaderboard
      } else if (apiData.props?.initialState?.leaderboard) {
        return apiData.props.initialState.leaderboard
      }
    }

    // 方法2: 直接从 DOM 提取数据
    console.log('尝试从 DOM 提取数据...')
    const domData = await page.evaluate(() => {
      const rows = []
      // 根据实际页面结构调整选择器
      const tableRows = document.querySelectorAll('table tbody tr, [data-testid="leaderboard-row"], .leaderboard-row')
      
      tableRows.forEach((row, index) => {
        const cells = row.querySelectorAll('td, [class*="cell"]')
        if (cells.length >= 3) {
          rows.push({
            rank: index + 1,
            // 根据实际页面结构调整字段提取
            address: cells[0]?.textContent?.trim() || '',
            roi: parseFloat(cells[1]?.textContent?.replace(/[^0-9.-]/g, '') || '0'),
            pnl: parseFloat(cells[2]?.textContent?.replace(/[^0-9.-]/g, '') || '0'),
          })
        }
      })
      
      return rows
    })

    await browser.close()

    if (domData && domData.length > 0) {
      console.log(`从 DOM 提取到 ${domData.length} 条数据`)
      return domData
    }

    throw new Error('无法从页面提取数据')
  } catch (error) {
    console.error('网页爬取失败:', error.message)
    return null
  }
}

/**
 * 方法3: 监听网络请求获取 API 数据
 * 这个方法需要在浏览器中手动操作，然后保存响应数据
 */
function parseManualJSON(jsonPath) {
  try {
    const rawData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    
    // 支持多种 JSON 格式
    // Binance Web3 API 格式: { code: "000000", data: { data: [...], pages: 36, size: 25, current: 1 } }
    if (rawData.data && rawData.data.data && Array.isArray(rawData.data.data)) {
      console.log(`检测到 Binance Web3 API 格式，总页数: ${rawData.data.pages}, 当前页: ${rawData.data.current}, 每页: ${rawData.data.size}`)
      return rawData.data.data
    } else if (Array.isArray(rawData)) {
      return rawData
    } else if (rawData.data && Array.isArray(rawData.data)) {
      return rawData.data
    } else if (rawData.result && Array.isArray(rawData.result)) {
      return rawData.result
    } else if (rawData.list && Array.isArray(rawData.list)) {
      return rawData.list
    } else if (rawData.leaderboard && Array.isArray(rawData.leaderboard)) {
      return rawData.leaderboard
    } else {
      throw new Error('无法识别 JSON 格式')
    }
  } catch (error) {
    console.error('解析 JSON 文件失败:', error.message)
    throw error
  }
}

/**
 * 标准化数据格式
 * 支持 Binance Web3 Leaderboard API 响应格式
 */
function normalizeData(rawData) {
  // 如果数据是嵌套的（如 { data: { data: [...] } }），提取数组
  let dataArray = rawData
  if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
    if (rawData.data && Array.isArray(rawData.data)) {
      dataArray = rawData.data
    } else if (rawData.result && Array.isArray(rawData.result)) {
      dataArray = rawData.result
    } else if (rawData.list && Array.isArray(rawData.list)) {
      dataArray = rawData.list
    }
  }

  return dataArray.map((item, index) => {
    // Binance Web3 Leaderboard 数据结构
    const traderId = item.address || item.encryptedUid || item.uid || item.walletAddress || item.userId || String(item.id || index)
    const handle = item.addressLabel || item.nickName || item.nickname || item.name || item.username || item.handle || null
    
    // 处理 ROI：realizedPnlPercent 已经是百分比形式（如 2.32 表示 2.32%），直接使用
    // 如果值看起来是小数形式（绝对值 < 0.01），可能需要乘以 100，但通常 Binance Web3 API 返回的已经是百分比
    let roi = null
    if (item.realizedPnlPercent != null) {
      const roiValue = Number(item.realizedPnlPercent)
      // Binance Web3 API 的 realizedPnlPercent 已经是百分比形式，直接使用
      // 但如果值非常小（< 0.01），可能是小数形式，需要乘以 100
      roi = Math.abs(roiValue) < 0.01 ? roiValue * 100 : roiValue
    } else if (item.profitRate != null) {
      // 也支持 profitRate 字段
      const roiValue = Number(item.profitRate)
      roi = Math.abs(roiValue) < 0.01 ? roiValue * 100 : roiValue
    } else {
      // 回退到其他字段
      roi = Number(item.roi || item.returnRate || item.return || item.performance || item.profit || 0)
    }
    
    const pnl = item.realizedPnl != null ? Number(item.realizedPnl) : (item.pnl != null ? Number(item.pnl) : (item.profit != null ? Number(item.profit) : null))
    const followers = item.followerCount != null ? Number(item.followerCount) : (item.followers != null ? Number(item.followers) : null)
    const avatarUrl = item.addressLogo || item.userPhotoUrl || item.avatar || item.avatarUrl || item.profilePicture || null
    
    // 提取额外字段
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
      // 额外字段
      winRate: winRate,
      volume_90d: totalVolume,
      avg_buy_90d: avgBuyVolume,
      lastActivity: lastActivity,
      // 保留原始数据用于调试
      _raw: item,
    }
  })
}

/**
 * 导入数据到 Supabase
 */
async function importToSupabase(normalizedData, sourceType = 'binance_web3') {
  // 过滤并排序：只保留有效的 ROI 数据（不限制数量，保留所有有效数据）
  const validData = normalizedData
    .filter(item => {
      const roi = item.roi
      return roi != null && !isNaN(Number(roi)) && isFinite(Number(roi))
    })
    .sort((a, b) => Number(b.roi) - Number(a.roi))
  
  // 输出前10条和后10条数据用于调试
  console.log('ROI 最高的 10 条数据:')
  validData.slice(0, 10).forEach((item, idx) => {
    console.log(`  ${idx + 1}. ROI: ${item.roi.toFixed(2)}%, PnL: ${item.pnl || 'N/A'}, Handle: ${item.nickName || item.encryptedUid}`)
  })
  if (validData.length > 20) {
    console.log('...')
    console.log('ROI 最低的 10 条数据:')
    validData.slice(-10).forEach((item, idx) => {
      console.log(`  ${validData.length - 9 + idx}. ROI: ${item.roi.toFixed(2)}%, PnL: ${item.pnl || 'N/A'}, Handle: ${item.nickName || item.encryptedUid}`)
    })
  }

  console.log(`筛选后条数（ROI Top 100）: ${validData.length}`)

  if (validData.length === 0) {
    console.error('没有有效的数据可导入')
    return
  }

  const capturedAt = new Date().toISOString()

  // 转换为 trader_sources 数据
  const sourcesData = validData.map(item => ({
    source: sourceType,
    source_type: 'leaderboard',
    source_trader_id: item.encryptedUid,
    handle: item.nickName || null,
    profile_url: item.userPhotoUrl || null,
    is_active: true,
    market_type: 'web3', // Web3 数据
    source_kind: 'public',
    identity_type: 'trader',
  }))

  // 转换为 trader_snapshots 数据
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

  // 分批写入 trader_sources（upsert）
  const BATCH_SIZE = 100
  let sourcesSuccess = 0
  let sourcesError = 0

  for (let i = 0; i < sourcesData.length; i += BATCH_SIZE) {
    const batch = sourcesData.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_sources')
      .upsert(batch, { onConflict: 'source,source_type,source_trader_id' })

    if (error) {
      console.error(`trader_sources 批次 ${Math.floor(i / BATCH_SIZE) + 1} 错误:`, error.message)
      sourcesError += batch.length
    } else {
      sourcesSuccess += batch.length
      console.log(`trader_sources 批次 ${Math.floor(i / BATCH_SIZE) + 1} 成功: ${batch.length} 条`)
    }
  }

  console.log(`trader_sources 导入: 成功 ${sourcesSuccess}, 失败 ${sourcesError}`)

  // 分批写入 trader_snapshots（insert）
  let snapshotsSuccess = 0
  let snapshotsError = 0

  for (let i = 0; i < snapshotsData.length; i += BATCH_SIZE) {
    const batch = snapshotsData.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_snapshots')
      .insert(batch)

    if (error) {
      console.error(`trader_snapshots 批次 ${Math.floor(i / BATCH_SIZE) + 1} 错误:`, error.message)
      snapshotsError += batch.length
    } else {
      snapshotsSuccess += batch.length
      console.log(`trader_snapshots 批次 ${Math.floor(i / BATCH_SIZE) + 1} 成功: ${batch.length} 条`)
    }
  }

  console.log(`trader_snapshots 导入: 成功 ${snapshotsSuccess}, 失败 ${snapshotsError}`)
  console.log(`完成！共导入 ${validData.length} 条 Binance Web3 ROI Top 100 交易员数据`)
}

/**
 * 主函数
 */
async function main() {
  const jsonPath = process.argv[2]
  const chain = process.argv[3] || 'bsc' // 默认 BSC

  let rawData = null

  if (jsonPath) {
    // 从 JSON 文件导入（推荐方式）
    console.log(`从文件读取数据: ${jsonPath}`)
    rawData = parseManualJSON(jsonPath)
    console.log(`从文件读取到 ${rawData.length} 条数据`)
  } else {
    // 尝试自动获取数据
    console.log('未提供 JSON 文件，尝试自动获取数据...')
    console.log('')

    // 方法1: 尝试 API
    console.log('=== 方法1: 尝试从 API 获取 ===')
    rawData = await fetchFromBinanceWeb3API(chain, 100)

    // 方法2: 如果 API 失败，尝试网页爬取
    if (!rawData || rawData.length === 0) {
      console.log('')
      console.log('=== 方法2: 尝试网页爬取 ===')
      rawData = await fetchFromWebPage(chain, 100)
    }

    if (!rawData || rawData.length === 0) {
      console.log('')
      console.error('自动获取数据失败！')
      console.log('')
      console.log('请使用以下方法之一：')
      console.log('1. 手动导出 JSON 数据：')
      console.log('   - 打开 https://web3.binance.com/en/leaderboard?chain=bsc')
      console.log('   - 打开浏览器开发者工具 (F12)')
      console.log('   - 切换到 Network 标签')
      console.log('   - 刷新页面，查找包含 leaderboard 的 API 请求')
      console.log('   - 复制响应数据，保存为 JSON 文件')
      console.log('   - 运行: node scripts/import_binance_web3_leaderboard.mjs <json-file>')
      console.log('')
      console.log('2. 安装 Puppeteer 进行自动爬取：')
      console.log('   npm install puppeteer')
      console.log('   然后重新运行此脚本')
      process.exit(1)
    }

    // 保存获取到的数据到文件（用于调试）
    const outputPath = `binance_web3_leaderboard_${Date.now()}.json`
    writeFileSync(outputPath, JSON.stringify(rawData, null, 2))
    console.log(`数据已保存到: ${outputPath}`)
  }

  // 标准化数据
  const normalizedData = normalizeData(rawData)
  console.log(`标准化后数据条数: ${normalizedData.length}`)
  console.log('示例数据:', JSON.stringify(normalizedData[0], null, 2))

  // 导入到 Supabase
  await importToSupabase(normalizedData, 'binance_web3')
}

// 运行
main().catch((error) => {
  console.error('导入失败:', error)
  process.exit(1)
})


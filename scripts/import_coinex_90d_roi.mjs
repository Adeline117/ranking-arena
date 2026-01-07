import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

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

  return rawData.map((item) => {
    // CoinEx API 数据结构
    // trader_id: "895EC555" (交易员ID)
    // nickname: "esisafarii" (昵称)
    // avatar: "https://..." (头像URL)
    // profit_rate: "2.96436384" (字符串格式，百分比数字)
    // profit_amount: "1888.29976783" (字符串格式，PnL)
    // winning_rate: "0.9523" (字符串格式，小数，0.9523 表示 95.23%)
    // cur_follower_num: 69 (数字，关注者数量)
    
    const traderId = item.trader_id || item.traderId || item.uid || String(item.id || '')
    const handle = item.nickname || item.nickName || item.displayName || item.account_name || item.name || null
    
    // ROI (profit_rate) 是字符串格式
    // 注意：CoinEx 的 profit_rate 可能是小数格式（0.0296），需要乘以 100 转换为百分比
    // 但根据实际数据检查，profit_rate 的值（如 2.96）看起来已经是百分比格式
    // 如果 CoinEx 官网显示的 ROI 是 296%，那么 profit_rate 应该是小数格式，需要乘以 100
    // 如果 CoinEx 官网显示的 ROI 是 2.96%，那么 profit_rate 已经是百分比格式，不需要乘以 100
    // 目前先按百分比格式处理，如果发现需要调整，可以修改这里
    let roi = 0
    if (item.profit_rate != null) {
      if (typeof item.profit_rate === 'string') {
        const roiNum = parseFloat(item.profit_rate)
        if (!isNaN(roiNum)) {
          // 如果值小于 10，可能是小数格式，需要乘以 100
          // 否则已经是百分比格式
          roi = roiNum < 10 ? roiNum * 100 : roiNum
        }
      } else if (typeof item.profit_rate === 'number') {
        roi = item.profit_rate < 10 ? item.profit_rate * 100 : item.profit_rate
      }
    }
    
    // PnL (profit_amount)
    let pnl = null
    if (item.profit_amount != null) {
      if (typeof item.profit_amount === 'string') {
        pnl = parseFloat(item.profit_amount)
        if (isNaN(pnl)) pnl = null
      } else if (typeof item.profit_amount === 'number') {
        pnl = item.profit_amount
      }
    }
    
    // 关注者数量
    const followers = item.cur_follower_num != null ? Number(item.cur_follower_num) : 
                     (item.follower_num != null ? Number(item.follower_num) :
                     (item.followers != null ? Number(item.followers) : 
                     (item.followCount != null ? Number(item.followCount) : 0)))
    
    // 头像
    const avatarUrl = item.avatar || item.avatarUrl || item.header || item.headPic || item.profilePhoto || null

    // 胜率 (winning_rate) 是字符串格式，小数（如 "0.9523" 表示 95.23%）
    let winRate = null
    if (item.winning_rate != null) {
      if (typeof item.winning_rate === 'string') {
        const winRateNum = parseFloat(item.winning_rate)
        if (!isNaN(winRateNum)) {
          winRate = winRateNum > 1 ? winRateNum / 100 : winRateNum // 如果是百分比数字，转换为小数
        }
      } else if (typeof item.winning_rate === 'number') {
        winRate = item.winning_rate > 1 ? item.winning_rate / 100 : item.winning_rate // 如果是百分比数字，转换为小数
      }
    }

    return {
      traderId: String(traderId),
      handle: handle,
      roi: roi,
      pnl: pnl,
      followerCount: Number(followers),
      avatarUrl: avatarUrl,
      winRate: winRate,
      _raw: item,
    }
  })
}

/**
 * 从 JSON 文件中提取数据行
 */
function extractRowsFromFile(fileData) {
  let rawData = null
  
  // 支持多种 JSON 格式
  if (Array.isArray(fileData)) {
    rawData = fileData
  } else if (fileData.data?.data?.data && Array.isArray(fileData.data.data.data)) {
    // CoinEx API 响应格式: { code: 0, data: { data: { data: [...] } } }
    rawData = fileData.data.data.data
  } else if (fileData.data?.data && Array.isArray(fileData.data.data)) {
    // CoinEx API 响应格式: { code: 0, data: { data: [...] } }
    rawData = fileData.data.data
  } else if (fileData.data?.content && Array.isArray(fileData.data.content)) {
    rawData = fileData.data.content
  } else if (fileData.data?.list && Array.isArray(fileData.data.list)) {
    rawData = fileData.data.list
  } else if (fileData.data?.rows && Array.isArray(fileData.data.rows)) {
    rawData = fileData.data.rows
  } else if (fileData.content && Array.isArray(fileData.content)) {
    rawData = fileData.content
  } else if (fileData.list && Array.isArray(fileData.list)) {
    rawData = fileData.list
  } else if (fileData.rows && Array.isArray(fileData.rows)) {
    rawData = fileData.rows
  }
  
  return rawData
}

/**
 * 使用 Puppeteer 获取 CoinEx 90天ROI排行榜数据
 */
async function fetchCoinex90dRoi() {
  console.log('=== CoinEx 90天ROI排行榜数据抓取 ===')
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

  let capturedData = []
  let capturedResponses = []

  page.on('response', async (response) => {
    const url = response.url()
    // 监听 CoinEx API
    if (url.includes('/copy-trading/public/traders') || (url.includes('coinex') && (url.includes('api') || url.includes('copy-trading')))) {
      try {
        const status = response.status()
        const data = await response.json().catch(() => null)
        
        if (!data) return
        
        // 记录响应信息
        capturedResponses.push({
          url: url.substring(0, 100),
          status,
          keys: Object.keys(data),
          code: data.code,
          hasData: !!(data.data && data.data),
          dataCount: data.data && data.data && data.data.data ? data.data.data.length : 0,
        })
        
        // 检查响应是否成功
        const isSuccess = status === 200 && (data.code === 0 || data.code === '0')
        
        if (isSuccess && data.data && data.data && data.data.data && Array.isArray(data.data.data)) {
          const content = data.data.data
          if (content.length > 0) {
            console.log(`✅ 从页面响应捕获到 traders 数据: ${content.length} 条`)
            console.log(`   URL: ${url.substring(0, 120)}`)
            
            // 解析 URL 参数判断页码
            const urlParams = new URLSearchParams(url.split('?')[1] || '')
            const pageNo = parseInt(urlParams.get('page') || '1')
            
            // 合并数据（去重，根据 trader_id）
            if (!capturedData || capturedData.length === 0) {
              capturedData = content
              console.log(`   (第 ${pageNo} 页) 初始数据: ${content.length} 条`)
            } else {
              const existingIds = new Set(capturedData.map((item) => item.trader_id || String(item.order)))
              const newRows = content.filter((item) => {
                const id = item.trader_id || String(item.order)
                return !existingIds.has(id)
              })
              if (newRows.length > 0) {
                capturedData.push(...newRows)
                console.log(`   (第 ${pageNo} 页) 新增 ${newRows.length} 条，累计: ${capturedData.length} 条`)
              } else {
                console.log(`   (第 ${pageNo} 页) 无新数据，可能重复`)
              }
            }
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  })

  try {
    // 先访问页面，然后在页面上下文中调用 API
    console.log('正在访问 CoinEx Copy Trading 页面...')
    const targetUrl = 'https://www.coinex.com/en/copy-trading/futures'
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 90000,
    })

    // 等待页面加载
    console.log('等待页面加载...')
    await new Promise(resolve => setTimeout(resolve, 5000))

    // 在页面上下文中调用 API 获取多页数据
    console.log('')
    console.log('=== 在页面上下文中调用 CoinEx API ===')
    const apiUrl = 'https://www.coinex.com/res/copy-trading/public/traders'
    
    // 获取多页数据（最多100条）
    const pageSize = 12 // CoinEx 每页12条
    const maxPages = Math.ceil(100 / pageSize) // 9页 = 108条，足够100条
    
    // 在页面上下文中一次性获取所有页面
    console.log(`准备获取最多 ${maxPages} 页数据（每页 ${pageSize} 条，目标 100 条）...`)
    const fetchedData = await page.evaluate(async (apiUrl, maxPages, pageSize) => {
      const logs = []
      const allRows = []
      
      for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
        try {
          const fetchUrl = `${apiUrl}?data_type=profit_rate&time_range=DAY90&hide_full=0&page=${pageNo}&limit=${pageSize}`
          logs.push(`开始获取第 ${pageNo} 页: ${fetchUrl}`)
          
          const res = await window.fetch(fetchUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Referer': window.location.href,
              'Origin': window.location.origin,
            },
          })
          
          logs.push(`第 ${pageNo} 页响应: ${res.status} ${res.statusText}`)
          
          if (res.ok) {
            const data = await res.json()
            logs.push(`第 ${pageNo} 页 code: ${data.code}, message: ${data.message}`)
            
            if (data.code === 0 && data.data && data.data && data.data.data && Array.isArray(data.data.data)) {
              const rowsCount = data.data.data.length
              allRows.push(...data.data.data)
              logs.push(`✅ 第 ${pageNo} 页: 获取到 ${rowsCount} 条，累计 ${allRows.length} 条`)
              logs.push(`   has_next: ${data.data.has_next}, total_page: ${data.data.total_page}`)
              
              // 如果没有更多数据或已获取足够数据，停止
              if (!data.data.has_next || rowsCount < pageSize || allRows.length >= 100) {
                logs.push(`停止获取: has_next=${data.data.has_next}, 已获取=${allRows.length}, 当前页=${rowsCount}`)
                break
              }
            } else {
              logs.push(`⚠️ 第 ${pageNo} 页: 数据格式不正确`)
            }
          } else {
            logs.push(`⚠️ 第 ${pageNo} 页: HTTP ${res.status}`)
          }
          
          // 延迟避免请求过快
          await new Promise(resolve => setTimeout(resolve, 800))
        } catch (e) {
          logs.push(`❌ 第 ${pageNo} 页异常: ${e.message}`)
        }
      }
      
      logs.push(`页面上下文请求完成，获取到 ${allRows.length} 条新数据`)
      return { rows: allRows, logs }
    }, apiUrl, maxPages, pageSize)
    
    // 显示日志
    if (fetchedData && fetchedData.logs) {
      console.log('')
      console.log('=== 页面上下文 API 调用日志 ===')
      fetchedData.logs.forEach(log => console.log(log))
      console.log('')
    }
    
    // 提取数据行
    const apiRows = fetchedData && fetchedData.rows ? fetchedData.rows : (Array.isArray(fetchedData) ? fetchedData : [])
    
    if (apiRows && apiRows.length > 0) {
      console.log(`✅ 从 API 获取到 ${apiRows.length} 条 CoinEx 数据`)
      
      // 与已捕获的数据合并（去重）
      if (capturedData && capturedData.length > 0) {
        console.log(`已从页面响应捕获到 ${capturedData.length} 条数据，开始合并...`)
        const existingIds = new Set(capturedData.map((item) => item.trader_id || String(item.order)))
        const newRows = apiRows.filter((item) => {
          const id = item.trader_id || String(item.order)
          return !existingIds.has(id)
        })
        if (newRows.length > 0) {
          capturedData.push(...newRows)
          console.log(`✅ 合并后总共: ${capturedData.length} 条`)
        } else {
          console.log(`ℹ️ 所有 API 数据已存在于捕获数据中`)
        }
      } else {
        capturedData = apiRows
      }
    }
    
    // 如果还是没有数据，尝试等待页面响应
    if (!capturedData || capturedData.length === 0) {
      console.log('等待页面响应...')
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      // 如果从响应监听中已经捕获到数据，使用它
      if (capturedData && capturedData.length > 0) {
        console.log(`✅ 从页面响应捕获到 ${capturedData.length} 条数据`)
      }
    }
  } catch (error) {
    console.error('❌ 错误:', error.message)
  } finally {
    await browser.close()
  }

  if (!capturedData || capturedData.length === 0) {
    throw new Error('无法获取数据，请检查网络连接或手动导出JSON数据')
  }

  return capturedData
}

/**
 * 导入数据到 Supabase
 */
async function importToSupabase(normalizedData) {
  console.log('')
  console.log('=== 开始导入数据到 Supabase ===')
  
  const capturedAt = new Date().toISOString()

  // 按 ROI 排序并筛选 Top 100
  const sortedData = normalizedData
    .filter(item => item.roi != null && !isNaN(item.roi))
    .sort((a, b) => b.roi - a.roi)
    .slice(0, 100)

  console.log(`筛选后条数（ROI Top 100）: ${sortedData.length}`)

  if (sortedData.length === 0) {
    console.error('没有有效的数据可导入')
    return
  }

  const sourcesData = sortedData.map((item) => ({
    source: 'coinex',
    source_type: 'copy_trading',
    source_trader_id: item.traderId,
    handle: item.handle,
    profile_url: item.avatarUrl || null,
  }))

  const snapshotsData = sortedData.map((item, index) => ({
    source: 'coinex',
    source_trader_id: item.traderId,
    rank: index + 1,
    roi: item.roi,
    pnl: item.pnl,
    win_rate: item.winRate,
    followers: item.followerCount != null ? Number(item.followerCount) : null,
    captured_at: capturedAt
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
  console.log(`完成！共导入 ${sortedData.length} 条 CoinEx 90天ROI Top 100 交易员数据`)
}

/**
 * 主函数
 */
async function main() {
  try {
    const { readFileSync, readdirSync, existsSync } = await import('fs')
    const { join } = await import('path')
    
    // 支持从 JSON 文件导入（如果提供了文件路径）
    const jsonPath = process.argv[2]
    
    let allRawData = []
    
    if (jsonPath) {
      // 如果提供了文件路径，加载该文件
      console.log(`从文件读取数据: ${jsonPath}`)
      if (!existsSync(jsonPath)) {
        console.error(`文件不存在: ${jsonPath}`)
        process.exit(1)
      }
      
      const fileData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      const rawData = extractRowsFromFile(fileData)
      
      if (rawData && Array.isArray(rawData)) {
        allRawData = rawData
        console.log(`从文件读取到 ${allRawData.length} 条数据`)
      } else {
        console.error('无法识别 JSON 文件格式')
        process.exit(1)
      }
    } else {
      // 没有提供文件路径，尝试自动加载所有 coinex JSON 文件
      const backupDir = join(process.cwd(), 'data', 'backup')
      console.log('自动查找 CoinEx JSON 文件...')
      
      if (existsSync(backupDir)) {
        const files = readdirSync(backupDir)
        const coinexFiles = files.filter(f => 
          f.includes('coinex') && f.endsWith('.json')
        ).sort()
        
        console.log(`找到 ${coinexFiles.length} 个 CoinEx JSON 文件`)
        
        for (const file of coinexFiles) {
          const filePath = join(backupDir, file)
          try {
            console.log(`  加载: ${file}`)
            const fileData = JSON.parse(readFileSync(filePath, 'utf-8'))
            const rawData = extractRowsFromFile(fileData)
            
            if (rawData && Array.isArray(rawData)) {
              allRawData.push(...rawData)
              console.log(`    ✅ 提取到 ${rawData.length} 条数据`)
            } else {
              console.log(`    ⚠️ 无法提取数据`)
            }
          } catch (e) {
            console.error(`    ❌ 读取文件失败: ${e.message}`)
          }
        }
        
        // 去重（根据 trader_id）
        if (allRawData.length > 0) {
          const uniqueMap = new Map()
          allRawData.forEach(item => {
            const id = item.trader_id || String(item.order || '')
            if (id && !uniqueMap.has(id)) {
              uniqueMap.set(id, item)
            }
          })
          allRawData = Array.from(uniqueMap.values())
          console.log(`合并去重后: ${allRawData.length} 条数据`)
        }
      }
      
      // 如果从文件加载失败或没有文件，使用 Puppeteer 抓取
      if (allRawData.length === 0) {
        console.log('没有找到 JSON 文件，使用 Puppeteer 抓取...')
        allRawData = await fetchCoinex90dRoi()
      }
    }
    
    if (!allRawData || allRawData.length === 0) {
      console.error('❌ 没有获取到数据')
      console.error('   请提供 JSON 文件路径，或将 JSON 文件放到 data/backup/ 目录下')
      process.exit(1)
    }
    
    console.log(`\n=== 开始处理 ${allRawData.length} 条数据 ===`)
    
    // 标准化数据
    const normalizedData = normalizeData(allRawData)
    console.log(`标准化后数据: ${normalizedData.length} 条`)
    console.log('示例数据:', JSON.stringify(normalizedData[0], null, 2))

    // 保存原始数据到备份目录
    const backupDir = join(process.cwd(), 'data', 'backup')
    const backupPath = join(backupDir, `coinex_90d_raw_${Date.now()}.json`)
    try {
      writeFileSync(backupPath, JSON.stringify(allRawData, null, 2), 'utf-8')
      console.log(`原始数据已保存到: ${backupPath}`)
    } catch (e) {
      console.warn(`保存备份失败: ${e.message}`)
    }

    // 导入到 Supabase
    await importToSupabase(normalizedData)
    
    console.log('')
    console.log('✅ 全部完成！')
  } catch (error) {
    console.error('❌ 错误:', error)
    process.exit(1)
  }
}

main()


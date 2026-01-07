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

  return rawData.map((item) => {
    // Bitget API 数据结构 (来自实际 API 响应)
    // traderId: "bdb34c728fb53d56a090"
    // nickName: "老枪"
    // displayName: "老枪"
    // roi: "12824.86" (字符串格式，已经是百分比数字，不是百分比)
    // totalPnl: "25370.35" (字符串格式)
    // followCount: 230 (数字)
    // header 或 headPic: 头像URL
    
    const traderId = item.traderId || item.uid || String(item.id || '')
    const handle = item.nickName || item.displayName || item.nickname || item.name || null
    
    // ROI 是字符串格式，直接转换为数字（已经是百分比数字，如 "12824.86" 表示 12824.86%）
    let roi = 0
    if (item.roi != null) {
      if (typeof item.roi === 'string') {
        const roiNum = parseFloat(item.roi)
        if (!isNaN(roiNum)) {
          roi = roiNum
        }
      } else if (typeof item.roi === 'number') {
        roi = item.roi
      }
    }
    
    // PnL (totalPnl)
    let pnl = null
    if (item.totalPnl != null) {
      if (typeof item.totalPnl === 'string') {
        pnl = parseFloat(item.totalPnl)
        if (isNaN(pnl)) pnl = null
      } else if (typeof item.totalPnl === 'number') {
        pnl = item.totalPnl
      }
    }
    
    // 关注者数量
    const followers = item.followCount != null ? Number(item.followCount) : 
                     (item.followers != null ? Number(item.followers) : 0)
    
    // 头像
    const avatarUrl = item.header || item.headPic || item.avatar || item.avatarUrl || item.profilePhoto || null

    // 胜率 (Bitget API 中没有直接的胜率字段，设为 null)
    let winRate = null

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
 * 使用 Puppeteer 获取 Bitget 90天ROI排行榜数据
 */
async function fetchBitget90dRoi() {
  console.log('=== Bitget 90天ROI排行榜数据抓取 ===')
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

  // 监听网络响应，捕获API数据
  let capturedData = null
  let capturedResponses = []
  
  page.on('response', async (response) => {
    const url = response.url()
    // 监听 Bitget API
    if (url.includes('leaderboard') || url.includes('ranking') || url.includes('copy-trading') || 
        (url.includes('bitget') && (url.includes('api') || url.includes('v1') || url.includes('v2')))) {
      try {
        const status = response.status()
        const data = await response.json().catch(() => null)
        
        if (!data) return
        
        // 记录所有相关响应
        capturedResponses.push({
          url: url.substring(0, 100),
          status,
          keys: Object.keys(data),
          code: data.code,
          hasData: !!data.data,
          dataKeys: data.data ? Object.keys(data.data) : [],
        })
        
        // 检查响应是否成功
        const isSuccess = status === 200 && (data.code === '00000' || data.code === 0 || data.success === true)
        
        if (isSuccess && data.data) {
          const result = data.data
          
          // 尝试多种数据路径
          let list = null
          
          if (Array.isArray(result)) {
            list = result
          } else if (result.list && Array.isArray(result.list)) {
            list = result.list
          } else if (result.leaderList && Array.isArray(result.leaderList)) {
            list = result.leaderList
          } else if (result.leaderboard && Array.isArray(result.leaderboard)) {
            list = result.leaderboard
          } else if (result.items && Array.isArray(result.items)) {
            list = result.items
          } else if (result.records && Array.isArray(result.records)) {
            list = result.records
          }
          
          // 如果 result 本身是对象，检查是否有嵌套的数组
          if (!list && typeof result === 'object') {
            for (const key in result) {
              if (Array.isArray(result[key]) && result[key].length > 0) {
                const firstItem = result[key][0]
                if (firstItem && (firstItem.uid || firstItem.userId || firstItem.nickName || firstItem.roi != null)) {
                  list = result[key]
                  break
                }
              }
            }
          }
          
          if (list && list.length > 0) {
            console.log(`✅ 捕获到数据: ${list.length} 条`)
            console.log(`   URL: ${url.substring(0, 120)}`)
            console.log(`   数据键: ${Object.keys(list[0] || {}).join(', ')}`)
            capturedData = list
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  })

  try {
    console.log('正在访问 Bitget Copy Trading 页面...')
    const targetUrl = 'https://www.bitget.com/asia/copy-trading/leaderboard-ranking/futures-roi/1?dateType=90'
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 90000,
    })

    // 等待页面完全加载
    console.log('等待页面加载...')
    await new Promise(resolve => setTimeout(resolve, 5000))

    // 尝试滚动页面以触发更多 API 请求
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await new Promise(resolve => setTimeout(resolve, 2000))

    // 如果还没有捕获到数据，尝试直接调用API
    if (!capturedData || capturedData.length === 0) {
      console.log('')
      console.log('=== 尝试直接调用 Bitget API ===')
      
      // 打印已捕获的响应信息
      if (capturedResponses.length > 0) {
        console.log('已捕获的响应:')
        capturedResponses.forEach((resp, i) => {
          console.log(`  ${i + 1}. ${resp.url}`)
          console.log(`     状态: ${resp.status}, 键: ${resp.keys.join(', ')}`)
        })
      }
      
      // 使用正确的 Bitget API 端点
      const apiUrl = 'https://www.bitget.com/v1/trigger/trace/public/traderRankingList'
      console.log(`尝试 API: ${apiUrl}`)
      
      // 获取多页数据（最多100条）
      let allRows = []
      let pageNo = 1
      const pageSize = 50 // Bitget 每页最多50条
      let hasMore = true
      
      while (hasMore && pageNo <= 2) { // 最多获取2页（100条）
        try {
          const fetchUrl = `${apiUrl}?pageNo=${pageNo}&pageSize=${pageSize}`
          console.log(`获取第 ${pageNo} 页数据...`)
          
          const response = await page.evaluate(async (fetchUrl) => {
            try {
              const res = await fetch(fetchUrl, {
                method: 'GET',
                headers: {
                  'Accept': 'application/json',
                  'Referer': 'https://www.bitget.com/',
                  'Origin': 'https://www.bitget.com',
                },
              })
              if (res.ok) {
                const data = await res.json()
                return { success: true, data }
              }
              return { success: false, status: res.status }
            } catch (e) {
              return { success: false, error: e.message }
            }
          }, fetchUrl)

          if (response.success && response.data) {
            const data = response.data
            
            if (data.code === '00000' || data.success === true) {
              if (data.data && data.data.rows && Array.isArray(data.data.rows)) {
                allRows.push(...data.data.rows)
                console.log(`✅ 第 ${pageNo} 页: 获取到 ${data.data.rows.length} 条`)
                
                // 检查是否还有更多数据
                hasMore = data.data.nextFlag === true && allRows.length < 100
              } else {
                console.log(`⚠️ 第 ${pageNo} 页: 数据格式不正确`)
                hasMore = false
              }
            } else {
              console.log(`⚠️ 第 ${pageNo} 页: API 返回错误 code=${data.code}, msg=${data.msg}`)
              hasMore = false
            }
          } else {
            console.log(`⚠️ 第 ${pageNo} 页: 请求失败 status=${response.status || 'unknown'}, error=${response.error || 'none'}`)
            hasMore = false
          }
          
          // 延迟避免请求过快
          if (hasMore) {
            await new Promise(resolve => setTimeout(resolve, 500))
          }
          
          pageNo++
        } catch (e) {
          console.log(`⚠️ 第 ${pageNo} 页获取异常:`, e.message)
          hasMore = false
        }
      }
      
      if (allRows.length > 0) {
        console.log(`✅ 总共获取到 ${allRows.length} 条 Bitget 数据`)
        capturedData = allRows
      }
      
      // 如果上面的 API 都不行，尝试从页面DOM提取
      if (!capturedData || capturedData.length === 0) {
        console.log('尝试从页面DOM提取数据...')
        try {
          const pageData = await page.evaluate(() => {
            // 尝试查找包含排行榜数据的脚本标签或全局变量
            const scripts = Array.from(document.querySelectorAll('script'))
            for (const script of scripts) {
              const text = script.textContent || ''
              if (text.includes('leaderboard') || text.includes('rankList') || text.includes('roi') || text.includes('ranking')) {
                try {
                  // 尝试匹配 JSON 数据
                  const jsonMatch = text.match(/\{[\s\S]*"list"[\s\S]*\}/) || text.match(/\{[\s\S]*"data"[\s\S]*\}/)
                  if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0])
                    if (parsed.list && Array.isArray(parsed.list)) {
                      return parsed.list
                    } else if (parsed.data && Array.isArray(parsed.data)) {
                      return parsed.data
                    }
                  }
                } catch (e) {
                  // 继续查找
                }
              }
            }
            
            // 尝试从表格中提取数据
            const rows = Array.from(document.querySelectorAll('table tr, .leaderboard-item, [class*="leaderboard"]'))
            if (rows.length > 0) {
              const extracted = []
              rows.forEach((row, idx) => {
                if (idx === 0) return // 跳过表头
                const cells = row.querySelectorAll('td, [class*="cell"]')
                if (cells.length >= 3) {
                  const name = cells[1]?.textContent?.trim()
                  const roiText = cells[2]?.textContent?.trim() || cells[3]?.textContent?.trim()
                  if (name && roiText) {
                    const roi = parseFloat(roiText.replace(/[+%]/g, ''))
                    if (!isNaN(roi)) {
                      extracted.push({
                        uid: `bitget_${idx}`,
                        nickName: name,
                        roi: roi,
                      })
                    }
                  }
                }
              })
              if (extracted.length > 0) {
                return extracted
              }
            }
            
            return null
          })
          
          if (pageData && pageData.length > 0) {
            capturedData = pageData
            console.log(`✅ 从DOM提取到数据: ${pageData.length} 条`)
          }
        } catch (e) {
          console.log('⚠️ 无法从DOM提取数据:', e.message)
        }
      }
    }

    await browser.close()

    if (!capturedData || capturedData.length === 0) {
      throw new Error('无法获取数据，请检查网络连接或手动导出JSON数据')
    }

    console.log(`✅ 获取到 ${capturedData.length} 条原始数据`)
    
    // 保存原始数据到文件（用于调试）
    try {
      const fs = await import('fs')
      const path = await import('path')
      const backupDir = path.join(process.cwd(), 'data', 'backup')
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true })
      }
      writeFileSync('data/backup/bitget_90d_raw.json', JSON.stringify(capturedData, null, 2))
      console.log('原始数据已保存到: data/backup/bitget_90d_raw.json')
    } catch (e) {
      console.log('⚠️ 保存备份文件失败:', e.message)
    }

    return capturedData
  } catch (error) {
    await browser.close()
    throw error
  }
}

/**
 * 导入数据到 Supabase
 */
async function importToSupabase(normalizedData) {
  console.log('')
  console.log('=== 开始导入数据到 Supabase ===')
  
  // 过滤并排序：只保留有效的 ROI 数据，取前100
  const validData = normalizedData
    .filter(item => item.roi != null && !isNaN(Number(item.roi)) && Number(item.roi) !== 0)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, 100)

  console.log(`筛选后条数（ROI Top 100）: ${validData.length}`)

  if (validData.length === 0) {
    console.error('没有有效的数据可导入')
    return
  }

  const capturedAt = new Date().toISOString()

  // 转换为 trader_sources 数据
  const sourcesData = validData.map((item, index) => ({
    source: 'bitget',
    source_type: 'leaderboard',
    source_trader_id: item.traderId,
    handle: item.handle,
    profile_url: item.avatarUrl,
    is_active: true,
    market_type: 'futures',
    source_kind: 'public',
    identity_type: 'trader'
  }))

  // 转换为 trader_snapshots 数据（rank 重新计算为 1-100）
  const snapshotsData = validData.map((item, index) => ({
    source: 'bitget',
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
  console.log(`完成！共导入 ${validData.length} 条 Bitget 90天ROI Top 100 交易员数据`)
}

/**
 * 主函数
 */
async function main() {
  try {
    // 支持从 JSON 文件导入（如果提供了文件路径）
    const jsonPath = process.argv[2]
    
    let rawData = null
    
    if (jsonPath) {
      console.log(`从文件读取数据: ${jsonPath}`)
      const { readFileSync } = await import('fs')
      rawData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      
      // 支持多种 JSON 格式
      if (Array.isArray(rawData)) {
        rawData = rawData
      } else if (rawData.data?.list) {
        rawData = rawData.data.list
      } else if (rawData.data?.records) {
        rawData = rawData.data.records
      } else if (rawData.result?.list) {
        rawData = rawData.result.list
      } else if (rawData.list) {
        rawData = rawData.list
      } else if (rawData.data) {
        rawData = rawData.data
      } else {
        throw new Error('无法识别 JSON 文件格式')
      }
      
      console.log(`从文件读取到 ${rawData.length} 条数据`)
    } else {
      // 使用 Puppeteer 抓取数据
      rawData = await fetchBitget90dRoi()
    }
    
    if (!rawData || rawData.length === 0) {
      console.error('未获取到数据')
      process.exit(1)
    }

    // 标准化数据
    const normalizedData = normalizeData(rawData)
    console.log(`标准化后数据: ${normalizedData.length} 条`)
    console.log('示例数据:', JSON.stringify(normalizedData[0], null, 2))

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


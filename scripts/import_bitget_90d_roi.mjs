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
    
    // 头像：Bitget API 可能返回的字段有 header、headPic、avatar 等
    // 这些应该是完整的头像URL（Bitget网页上显示的头像）
    // 优先使用 header（Bitget API的主要头像字段），然后是其他字段
    let avatarUrl = item.header || item.headPic || item.avatar || item.avatarUrl || item.profilePhoto || null
    
    // 如果头像URL看起来不完整（太短或没有http/https），尝试处理
    if (avatarUrl && typeof avatarUrl === 'string') {
      avatarUrl = avatarUrl.trim()
      // 如果URL不完整（没有协议），尝试添加
      if (avatarUrl && !avatarUrl.startsWith('http')) {
        if (avatarUrl.startsWith('//')) {
          avatarUrl = 'https:' + avatarUrl
        } else if (avatarUrl.startsWith('/')) {
          avatarUrl = 'https://www.bitget.com' + avatarUrl
        }
      }
    }
    
    // 调试：输出前几个trader的头像URL，确认格式
    if (avatarUrl && (handle && (handle.includes('老') || handle.includes('East') || handle.includes('Rock') || handle.includes('Encryption')))) {
      console.log(`[Bitget导入] Trader "${handle}" (${traderId}) 头像URL:`, {
        header: item.header || '(空)',
        headPic: item.headPic || '(空)',
        avatar: item.avatar || '(空)',
        avatarUrl: item.avatarUrl || '(空)',
        profilePhoto: item.profilePhoto || '(空)',
        final_avatarUrl: avatarUrl,
        avatarUrl_type: typeof avatarUrl,
        avatarUrl_length: avatarUrl?.length || 0,
        has_extension: /\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$|#)/i.test(avatarUrl),
      })
    }

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
    // 只监听 traderRankingList API（不监听 topRankingList）
    if (url.includes('traderRankingList') && !url.includes('topRankingList')) {
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
          hasRows: !!(data.data && data.data.rows),
          rowsCount: data.data && data.data.rows ? data.data.rows.length : 0,
        })
        
        // 检查响应是否成功
        const isSuccess = status === 200 && (data.code === '00000' || data.code === 0 || data.success === true)
        
        if (isSuccess && data.data && data.data.rows && Array.isArray(data.data.rows)) {
          const rows = data.data.rows
          if (rows.length > 0) {
            console.log(`✅ 从页面响应捕获到 traderRankingList 数据: ${rows.length} 条`)
            console.log(`   URL: ${url.substring(0, 120)}`)
            
            // 解析 URL 参数判断页码
            const urlParams = new URLSearchParams(url.split('?')[1] || '')
            const pageNo = parseInt(urlParams.get('pageNo') || '1')
            
            // 合并数据（去重，根据 traderId 或 rankingNo）
            if (!capturedData || capturedData.length === 0) {
              capturedData = rows
              console.log(`   (第 ${pageNo} 页) 初始数据: ${rows.length} 条`)
            } else {
              const existingIds = new Set(capturedData.map((item) => item.traderId || item.uid || String(item.rankingNo)))
              const newRows = rows.filter((item) => {
                const id = item.traderId || item.uid || String(item.rankingNo)
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
    console.log('正在访问 Bitget Copy Trading 页面...')
    const targetUrl = 'https://www.bitget.com/asia/copy-trading/leaderboard-ranking/futures-roi/1?dateType=90'
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 90000,
    })

    // 等待页面加载
    console.log('等待页面加载...')
    await new Promise(resolve => setTimeout(resolve, 5000))

    // 在页面上下文中调用 API 获取多页数据
    console.log('')
    console.log('=== 在页面上下文中调用 Bitget API ===')
    const apiUrl = 'https://www.bitget.com/v1/trigger/trace/public/traderRankingList'
      
    // 获取多页数据（最多100条）
    let allRows = []
    let pageNo = 1
    const pageSize = 50 // Bitget 每页最多50条
    let hasMore = true
    const maxPages = 2 // 最多2页（100条）
    
    // 尝试在页面上触发加载更多数据
    console.log(`准备在页面上触发加载更多数据（最多 ${maxPages} 页，目标 100 条）...`)
    
    // 等待页面初始数据加载完成
    await new Promise(resolve => setTimeout(resolve, 5000))
    
    // 在页面上下文中尝试多次请求不同页码的数据
    console.log('尝试在页面上下文中模拟多次 API 请求...')
    const fetchedData = await page.evaluate(async (apiUrl, maxPages, pageSize) => {
      const logs = []
      const allRows = []
      
      // 尝试直接调用 API（使用页面上下文，应该有正确的 Cookie 和 Headers）
      for (let pageNo = 2; pageNo <= maxPages; pageNo++) {
        try {
          logs.push(`尝试获取第 ${pageNo} 页数据...`)
          const fetchUrl = `${apiUrl}?pageNo=${pageNo}&pageSize=${pageSize}`
          
          // 使用 window.fetch，它应该有页面的上下文（Cookie、Headers等）
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
            logs.push(`第 ${pageNo} 页 code: ${data.code}`)
            
            if (data.code === '00000' && data.data && data.data.rows && Array.isArray(data.data.rows)) {
              const rowsCount = data.data.rows.length
              allRows.push(...data.data.rows)
              logs.push(`✅ 第 ${pageNo} 页: 获取到 ${rowsCount} 条，累计 ${allRows.length} 条`)
              
              // 如果没有更多数据，停止
              if (!data.data.nextFlag || rowsCount < pageSize) {
                logs.push(`没有更多数据了`)
                break
              }
            }
          } else {
            logs.push(`⚠️ 第 ${pageNo} 页: HTTP ${res.status}`)
          }
          
          // 延迟避免请求过快
          await new Promise(resolve => setTimeout(resolve, 1000))
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
    
    // 如果页面操作没有获取到新数据，依赖响应监听器捕获的数据
    // 响应监听器已经捕获了第一页的20条数据
    if (apiRows && apiRows.length > 0) {
      console.log(`✅ 从 API 获取到 ${apiRows.length} 条 Bitget 数据`)
      
      // 与已捕获的数据合并（去重）
      if (capturedData && capturedData.length > 0) {
        console.log(`已从页面响应捕获到 ${capturedData.length} 条数据，开始合并...`)
        const existingIds = new Set(capturedData.map((item) => item.traderId || item.uid || String(item.rankingNo)))
        const newRows = apiRows.filter((item) => {
          const id = item.traderId || item.uid || String(item.rankingNo)
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
    } else {
      // 如果通过页面上下文获取失败，尝试从捕获的响应中查找
      console.log('')
      console.log('=== 从页面捕获的响应中查找数据 ===')
      if (capturedResponses.length > 0) {
        console.log('已捕获的响应:')
        capturedResponses.forEach((resp, i) => {
          console.log(`  ${i + 1}. ${resp.url}`)
          if (resp.url.includes('traderRankingList')) {
            console.log(`     ✅ 找到 traderRankingList 响应`)
          }
        })
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
    
    // 从页面DOM提取头像URL：补充API返回的头像数据
    if (capturedData && Array.isArray(capturedData) && capturedData.length > 0) {
      console.log('')
      console.log('=== 从页面DOM提取头像URL ===')
      try {
        // 等待页面完全加载
        await new Promise(resolve => setTimeout(resolve, 3000))
        
        const avatarMap = await page.evaluate(() => {
          const avatarMap = {}
          
          // 查找所有头像图片元素
          const avatarImages = Array.from(document.querySelectorAll('img[src*="bgstatic"], img[src*="avatar"], img[src*="headPic"], img[src*="header"], [class*="avatar"] img, [class*="headPic"] img'))
          
          avatarImages.forEach((img) => {
            const src = img.src || img.getAttribute('src') || ''
            if (src && (src.includes('bgstatic') || src.includes('avatar') || src.includes('headPic') || src.includes('header'))) {
              // 查找包含trader ID或名字的父元素
              const row = img.closest('tr, .leaderboard-item, [class*="leaderboard"], [class*="trader"], [class*="row"], [class*="item"]')
              if (row) {
                // 尝试从行元素中提取trader ID或名字
                const nameElement = row.querySelector('.name, [class*="name"], [class*="nickName"], [class*="displayName"]') || row
                const name = nameElement.textContent?.trim() || ''
                
                // 尝试提取traderId（从链接、data属性等）
                const link = row.querySelector('a[href*="trader"], a[href*="user"], a[href*="copy-trading"]')
                let traderId = null
                if (link) {
                  const href = link.getAttribute('href') || ''
                  const match = href.match(/trader[\/=]([^\/\?&]+)|user[\/=]([^\/\?&]+)|copy-trading[\/=]([^\/\?&]+)/)
                  traderId = match?.[1] || match?.[2] || match?.[3]
                }
                
                traderId = traderId || 
                          row.getAttribute('data-trader-id') || 
                          row.getAttribute('data-uid') ||
                          row.getAttribute('data-id') ||
                          name
                
                if (traderId && src) {
                  // 存储完整的头像URL（包括协议和域名）
                  avatarMap[traderId] = src
                }
              }
            }
          })
          
          return avatarMap
        })
        
        if (Object.keys(avatarMap).length > 0) {
          console.log(`✅ 从DOM提取到 ${Object.keys(avatarMap).length} 个头像URL`)
          console.log('头像URL样本（前5个）:')
          Object.entries(avatarMap).slice(0, 5).forEach(([id, url]) => {
            console.log(`  ${id}: ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`)
          })
          
          // 将DOM提取的头像URL合并到API数据中
          let updatedCount = 0
          capturedData.forEach(item => {
            const traderId = item.traderId || item.uid || String(item.rankingNo || '')
            const name = item.nickName || item.displayName || item.name || ''
            
            // 尝试匹配trader ID或名字
            const matchedUrl = avatarMap[traderId] || avatarMap[name] || 
                               Object.values(avatarMap).find(url => url.includes(traderId))
            
            if (matchedUrl) {
              // 如果API返回的头像URL为空或不完整，使用DOM提取的完整URL
              const apiAvatar = item.header || item.headPic || item.avatar || item.avatarUrl || item.profilePhoto
              if (!apiAvatar || apiAvatar.length < 50) {
                item.header = matchedUrl // 设置header字段，normalizeData优先使用header
                item.avatarUrl = matchedUrl
                updatedCount++
              } else if (matchedUrl.length > apiAvatar.length) {
                // 如果DOM提取的URL更长（可能更完整），使用它
                item.header = matchedUrl
                item.avatarUrl = matchedUrl
                updatedCount++
              }
            }
          })
          
          if (updatedCount > 0) {
            console.log(`✅ 更新了 ${updatedCount} 个头像URL`)
          }
        } else {
          console.log('⚠️ 未能从DOM提取到头像URL')
        }
      } catch (e) {
        console.warn('从DOM提取头像URL失败:', e.message)
      }
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
 * 从 JSON 文件中提取数据行
 */
function extractRowsFromFile(fileData) {
  let rawData = null
  
  // 支持多种 JSON 格式
  if (Array.isArray(fileData)) {
    rawData = fileData
  } else if (fileData.data?.data?.rows && Array.isArray(fileData.data.data.rows)) {
    // Bitget API 响应格式: { code: "00000", data: { data: { rows: [...] } } }
    rawData = fileData.data.data.rows
  } else if (fileData.data?.rows && Array.isArray(fileData.data.rows)) {
    // Bitget API 响应格式: { code: "00000", data: { rows: [...] } }
    rawData = fileData.data.rows
  } else if (fileData.data?.list && Array.isArray(fileData.data.list)) {
    rawData = fileData.data.list
  } else if (fileData.data?.records && Array.isArray(fileData.data.records)) {
        rawData = fileData.data.records
      } else if (fileData.result?.list && Array.isArray(fileData.result.list)) {
        rawData = fileData.result.list
      } else if (fileData.list && Array.isArray(fileData.list)) {
        rawData = fileData.list
      } else if (fileData.data && Array.isArray(fileData.data)) {
        rawData = fileData.data
      } else if (fileData.rows && Array.isArray(fileData.rows)) {
        rawData = fileData.rows
      }
      
      return rawData
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
      // 没有提供文件路径，尝试自动加载所有 bitget JSON 文件
      const { readFileSync, readdirSync, existsSync } = await import('fs')
      const { join } = await import('path')
      
      const backupDir = join(process.cwd(), 'data', 'backup')
      console.log('自动查找 Bitget JSON 文件...')
      
      let allRawData = []
      
      if (existsSync(backupDir)) {
        const files = readdirSync(backupDir)
        const bitgetFiles = files.filter(f => 
          f.includes('bitget') && f.endsWith('.json')
        ).sort()
        
        console.log(`找到 ${bitgetFiles.length} 个 Bitget JSON 文件`)
        
        for (const file of bitgetFiles) {
          const filePath = join(backupDir, file)
          try {
            console.log(`  加载: ${file}`)
            const fileData = JSON.parse(readFileSync(filePath, 'utf-8'))
            
            // 提取数据
            let fileRawData = null
            if (Array.isArray(fileData)) {
              fileRawData = fileData
            } else if (fileData.data?.data?.rows && Array.isArray(fileData.data.data.rows)) {
              fileRawData = fileData.data.data.rows
            } else if (fileData.data?.rows && Array.isArray(fileData.data.rows)) {
              fileRawData = fileData.data.rows
            } else if (fileData.data?.list && Array.isArray(fileData.data.list)) {
              fileRawData = fileData.data.list
            } else if (fileData.rows && Array.isArray(fileData.rows)) {
              fileRawData = fileData.rows
            }
            
            if (fileRawData && Array.isArray(fileRawData)) {
              allRawData.push(...fileRawData)
              console.log(`    ✅ 提取到 ${fileRawData.length} 条数据`)
            } else {
              console.log(`    ⚠️ 无法提取数据`)
            }
          } catch (e) {
            console.error(`    ❌ 读取文件失败: ${e.message}`)
          }
        }
        
        // 去重（根据 traderId）
        if (allRawData.length > 0) {
          const uniqueMap = new Map()
          allRawData.forEach(item => {
            const id = item.traderId || item.uid || String(item.rankingNo || '')
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
        allRawData = await fetchBitget90dRoi()
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

      // 导入到 Supabase
      await importToSupabase(normalizedData)
    }
    
    console.log('')
    console.log('✅ 全部完成！')
  } catch (error) {
    console.error('❌ 错误:', error)
    process.exit(1)
  }
}

main()


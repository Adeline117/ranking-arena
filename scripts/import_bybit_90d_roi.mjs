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
    // Bybit dynamic-leader-list API 数据结构
    const traderId = item.leaderUserId || String(item.id || '')
    const handle = item.nickName || null
    
    // ROI 在 metricValues 数组的第一个位置（格式如 "+13.46%"）
    let roi = 0
    if (item.metricValues && Array.isArray(item.metricValues) && item.metricValues.length > 0) {
      const roiStr = item.metricValues[0] // 第一个是 ROI
      if (roiStr && typeof roiStr === 'string') {
        // 移除 + 或 - 号和 % 号，转换为数字
        const roiNum = parseFloat(roiStr.replace(/[+%]/g, ''))
        if (!isNaN(roiNum)) {
          roi = roiNum
        }
      }
    }
    
    // PnL 可能在 followerYieldE8（需要除以 1e8）
    let pnl = null
    if (item.followerYieldE8 != null) {
      pnl = Number(item.followerYieldE8) / 1e8
    }
    
    // 注意：不再获取 followers，因为所有 trader 的粉丝数只能来源 Arena 注册用户的关注
    // const followers = item.currentFollowerCount != null ? Number(item.currentFollowerCount) : 0
    
    // 头像
    const avatarUrl = item.profilePhoto || null

    // 胜率在 metricValues 数组的第4个位置（索引3，格式如 "+95.73%"）
    let winRate = null
    if (item.metricValues && Array.isArray(item.metricValues) && item.metricValues.length > 3) {
      const winRateStr = item.metricValues[3] // 第4个是 WinRate
      if (winRateStr && typeof winRateStr === 'string') {
        const winRateNum = parseFloat(winRateStr.replace(/[+%]/g, ''))
        if (!isNaN(winRateNum)) {
          winRate = winRateNum
        }
      }
    }

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
      traderId: String(traderId),
      handle: handle,
      roi: roi,
      pnl: pnl,
      followerCount: null, // 已废弃，不再从交易所 API 获取
      avatarUrl: avatarUrl,
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
 * 使用 Puppeteer 获取 Bybit 90天ROI排行榜数据
 */
async function fetchBybit90dRoi() {
  console.log('=== Bybit 90天ROI排行榜数据抓取 ===')
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
    // 监听所有可能的排行榜 API
    if (url.includes('trader-leaderboard') || (url.includes('beehive') && url.includes('leaderboard'))) {
      try {
        const status = response.status()
        const data = await response.json().catch(() => null)
        
        if (!data) return
        
        // 记录所有相关响应
        capturedResponses.push({
          url: url.substring(0, 100),
          status,
          keys: Object.keys(data),
          retCode: data.retCode,
          hasResult: !!data.result,
          resultKeys: data.result ? Object.keys(data.result) : [],
        })
        
        // 检查响应是否成功
        const isSuccess = status === 200 && (data.retCode === 0 || data.retCode === '0' || data.code === 0)
        
        if (isSuccess && data.result) {
          const result = data.result
          
          // 尝试多种数据路径
          let list = null
          
          // 检查 result 中的各种可能字段
          if (Array.isArray(result)) {
            list = result
          } else if (result.list && Array.isArray(result.list)) {
            list = result.list
          } else if (result.leaderList && Array.isArray(result.leaderList)) {
            list = result.leaderList
          } else if (result.leaderboard && Array.isArray(result.leaderboard)) {
            list = result.leaderboard
          } else if (result.data && Array.isArray(result.data)) {
            list = result.data
          } else if (result.traders && Array.isArray(result.traders)) {
            list = result.traders
          } else if (result.items && Array.isArray(result.items)) {
            list = result.items
          }
          
          // 如果 result 本身是对象，检查是否有嵌套的数组
          if (!list && typeof result === 'object') {
            // 查找所有数组类型的值
            for (const key in result) {
              if (Array.isArray(result[key]) && result[key].length > 0) {
                // 检查数组元素是否像交易员数据（有 uid, nickname, roi 等字段）
                const firstItem = result[key][0]
                if (firstItem && (firstItem.uid || firstItem.leaderUid || firstItem.nickName || firstItem.roi != null)) {
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
    console.log('正在访问 Bybit Copy Trading 页面...')
    await page.goto('https://www.bybit.com/copyTrade/', {
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

    // 尝试查找并点击90天筛选
    console.log('尝试查找90天筛选器...')
    try {
      // 等待排行榜容器加载
      await page.waitForSelector('body', { timeout: 10000 })
      
      // 尝试多种方式查找90天筛选
      const selectors = [
        'button[class*="90"]',
        'button[class*="period"]',
        '[data-testid*="90"]',
        '[data-period="90"]',
        'button:has-text("90D")',
        'button:has-text("90")',
        '.period-selector button',
        'select option[value="90"]',
        'select option[value="90d"]',
        'select option[value="LEADERBOARD_PERIOD_90D"]',
      ]
      
      let clicked = false
      for (const selector of selectors) {
        try {
          const elements = await page.$$(selector)
          for (const element of elements) {
            const text = await page.evaluate(el => el.textContent || '', element)
            if (text.includes('90') || text.includes('3M') || text.includes('Quarter')) {
              await element.click()
              console.log(`✅ 点击了筛选器: ${selector} (${text})`)
              await new Promise(resolve => setTimeout(resolve, 3000))
              clicked = true
              break
            }
          }
          if (clicked) break
        } catch (e) {
          // 继续尝试
        }
      }
      
      if (!clicked) {
        console.log('⚠️ 无法找到90天筛选器，将尝试直接调用API')
      }
    } catch (e) {
      console.log('⚠️ 查找筛选器时出错，将尝试直接调用API:', e.message)
    }

    // 如果还没有捕获到数据，尝试直接调用API
    if (!capturedData || capturedData.length === 0) {
      console.log('')
      console.log('=== 尝试直接调用 Bybit API ===')
      
      // 打印已捕获的响应信息
      if (capturedResponses.length > 0) {
        console.log('已捕获的响应:')
        capturedResponses.forEach((resp, i) => {
          console.log(`  ${i + 1}. ${resp.url}`)
          console.log(`     状态: ${resp.status}, 键: ${resp.keys.join(', ')}, 有列表: ${resp.hasList}`)
        })
      }
      
      // 使用正确的 API 端点获取90天ROI数据
      const apiUrl = 'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list'
      const pageSize = 100 // 每页大小
      
      console.log('\n=== 开始获取 Bybit 90天ROI排行榜数据 ===')
      
      // 先获取第一页，了解总页数
      let allLeaders = []
      let totalPages = 1
      let currentPage = 1
      
      try {
        const firstPageUrl = `${apiUrl}?pageNo=1&pageSize=${pageSize}&dataDuration=DATA_DURATION_NINETY_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI&sortType=SORT_TYPE_DESC`
        console.log(`获取第 1 页数据...`)
        
        const firstResponse = await page.evaluate(async (fetchUrl) => {
          try {
            const res = await fetch(fetchUrl, {
              method: 'GET',
              headers: {
                'Accept': 'application/json',
                'Referer': 'https://www.bybit.com/',
                'Origin': 'https://www.bybit.com',
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
        }, firstPageUrl)

        if (firstResponse.success && firstResponse.data) {
          const data = firstResponse.data
          
          if (data.retCode !== 0) {
            throw new Error(`API 返回错误: retCode=${data.retCode}, retMsg=${data.retMsg}`)
          }
          
          if (data.result && data.result.leaderDetails) {
            allLeaders.push(...data.result.leaderDetails)
            totalPages = Math.min(parseInt(data.result.totalPageCount || '1'), 10) // 最多获取10页（1000条）
            console.log(`✅ 第 1 页: 获取到 ${data.result.leaderDetails.length} 条，总共 ${data.result.totalCount} 条，${totalPages} 页`)
            
            // 获取剩余页面（最多到前10页，确保有足够的数据）
            for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
              await new Promise(resolve => setTimeout(resolve, 500)) // 延迟避免请求过快
              
              const pageUrl = `${apiUrl}?pageNo=${pageNum}&pageSize=${pageSize}&dataDuration=DATA_DURATION_NINETY_DAY&sortField=LEADER_SORT_FIELD_SORT_ROI&sortType=SORT_TYPE_DESC`
              console.log(`获取第 ${pageNum} 页数据...`)
              
              try {
                const pageResponse = await page.evaluate(async (fetchUrl) => {
                  try {
                    const res = await fetch(fetchUrl, {
                      method: 'GET',
                      headers: {
                        'Accept': 'application/json',
                        'Referer': 'https://www.bybit.com/',
                        'Origin': 'https://www.bybit.com',
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
                }, pageUrl)
                
                if (pageResponse.success && pageResponse.data && pageResponse.data.retCode === 0) {
                  if (pageResponse.data.result && pageResponse.data.result.leaderDetails) {
                    allLeaders.push(...pageResponse.data.result.leaderDetails)
                    console.log(`✅ 第 ${pageNum} 页: 获取到 ${pageResponse.data.result.leaderDetails.length} 条`)
                  }
                } else {
                  console.log(`⚠️ 第 ${pageNum} 页获取失败: ${pageResponse.error || `状态码 ${pageResponse.status}`}`)
                  break
                }
              } catch (e) {
                console.log(`⚠️ 第 ${pageNum} 页获取异常: ${e.message}`)
                break
              }
            }
            
            console.log(`\n✅ 总共获取到 ${allLeaders.length} 条交易员数据`)
            capturedData = allLeaders
          } else {
            throw new Error('响应格式不正确：缺少 result.leaderDetails')
          }
        } else {
          throw new Error(`API 调用失败: ${firstResponse.error || `状态码 ${firstResponse.status}`}`)
        }
      } catch (e) {
        console.log(`⚠️ 获取数据失败:`, e.message)
      }
      
      // 如果上面的 API 都不行，尝试其他端点
      if (!capturedData || capturedData.length === 0) {
        console.log('\n尝试其他 API 端点...')
        const apiEndpoints = [
          { url: 'https://api.bybit.com/v5/copy-trading/leaderboard/select-leader', params: 'category=linear&period=90d&statType=ROI&limit=100' },
          { url: 'https://api.bybit.com/v5/copy-trading/leaderboard', params: 'category=linear&period=90d&statType=ROI&limit=100' },
        ]

        for (const { url: endpoint, params } of apiEndpoints) {
          try {
            const fullUrl = `${endpoint}?${params}`
            console.log(`尝试: ${endpoint}`)
            
            const response = await page.evaluate(async (fetchUrl) => {
              try {
                const res = await fetch(fetchUrl, {
                  method: 'GET',
                  headers: {
                    'Accept': 'application/json',
                  },
                })
                if (res.ok) {
                  return { success: true, data: await res.json() }
                }
                return { success: false, status: res.status }
              } catch (e) {
                return { success: false, error: e.message }
              }
            }, fullUrl)

            if (response.success && response.data) {
              const data = response.data
              if ((data.retCode === 0 || data.code === 0) && (data.result || data.data)) {
                const result = data.result || data.data
                if (result.list || result.leaderList || Array.isArray(result)) {
                  const list = result.list || result.leaderList || result
                  if (list.length > 0) {
                    console.log(`✅ 成功获取数据: ${list.length} 条`)
                    capturedData = list
                    break
                  }
                }
              }
            }
          } catch (e) {
            console.log(`⚠️ API 调用失败: ${endpoint}`, e.message)
          }
        }
      }
    }

    // 如果还是没有数据，等待更长时间并再次检查响应
    if (!capturedData || capturedData.length === 0) {
      console.log('\n等待更多 API 响应...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      
      // 再次尝试滚动和等待
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
      })
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      // 如果还是没有数据，尝试从页面DOM提取
      if (!capturedData || capturedData.length === 0) {
        console.log('尝试从页面DOM提取数据...')
        try {
          const pageData = await page.evaluate(() => {
            // 尝试查找包含排行榜数据的脚本标签或全局变量
            const scripts = Array.from(document.querySelectorAll('script'))
            for (const script of scripts) {
              const text = script.textContent || ''
              if (text.includes('leaderboard') || text.includes('leaderList') || text.includes('roi90') || text.includes('traderList')) {
                try {
                  // 尝试匹配 JSON 数据
                  const jsonMatch = text.match(/\{[\s\S]*"list"[\s\S]*\}/)
                  if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0])
                    if (parsed.list && Array.isArray(parsed.list)) {
                      return parsed.list
                    }
                  }
                } catch (e) {
                  // 继续查找
                }
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
    writeFileSync('data/backup/bybit_90d_raw.json', JSON.stringify(capturedData, null, 2))
    console.log('原始数据已保存到: data/backup/bybit_90d_raw.json')

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
    source: 'bybit',
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
  // 注意：不再保存 followers 字段，因为所有 trader 的粉丝数只能来源 Arena 注册用户的关注
  // 如果数据库表中有 followers 列且不允许 NULL，可以设置为 0，但代码中不再使用此值
  const snapshotsData = validData.map((item, index) => {
    const snapshot = {
      source: 'bybit',
      source_trader_id: item.traderId,
      rank: index + 1,
      roi: item.roi,
      pnl: item.pnl,
      win_rate: item.winRate,
      roi_7d: item.roi_7d != null && !isNaN(item.roi_7d) ? Number(item.roi_7d) : null,
      roi_30d: item.roi_30d != null && !isNaN(item.roi_30d) ? Number(item.roi_30d) : null,
      roi_1y: item.roi_1y != null && !isNaN(item.roi_1y) ? Number(item.roi_1y) : null,
      roi_2y: item.roi_2y != null && !isNaN(item.roi_2y) ? Number(item.roi_2y) : null,
      total_trades: item.totalTrades != null && !isNaN(item.totalTrades) ? Number(item.totalTrades) : null,
      avg_profit: item.avgProfit != null && !isNaN(item.avgProfit) ? Number(item.avgProfit) : null,
      avg_loss: item.avgLoss != null && !isNaN(item.avgLoss) ? Number(item.avgLoss) : null,
      profitable_trades_pct: item.profitableTradesPct != null && !isNaN(item.profitableTradesPct) ? Number(item.profitableTradesPct) : null,
      captured_at: capturedAt,
    }
    // 如果数据库表中有 followers 列且不允许 NULL，设置为 0（但代码中不再使用此值）
    // snapshot.followers = 0
    return snapshot
  })

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
  console.log(`完成！共导入 ${validData.length} 条 Bybit 90天ROI Top 100 交易员数据`)
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
      } else if (rawData.result?.list) {
        rawData = rawData.result.list
      } else if (rawData.result?.leaderList) {
        rawData = rawData.result.leaderList
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
      rawData = await fetchBybit90dRoi()
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


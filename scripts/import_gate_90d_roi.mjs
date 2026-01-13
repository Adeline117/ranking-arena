import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'fs'
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
    // Gate.io API 数据结构
    const traderId = item.uid || item.leaderUid || item.traderId || String(item.id || '')
    const handle = item.nickName || item.nickname || item.name || null
    
    // ROI 字段
    let roi = 0
    if (item.roi != null) {
      const roiNum = typeof item.roi === 'string' 
        ? parseFloat(item.roi.replace(/[+%]/g, ''))
        : Number(item.roi)
      if (!isNaN(roiNum)) {
        roi = roiNum
      }
    } else if (item.returnRate != null) {
      const roiNum = typeof item.returnRate === 'string'
        ? parseFloat(item.returnRate.replace(/[+%]/g, ''))
        : Number(item.returnRate)
      if (!isNaN(roiNum)) {
        roi = roiNum
      }
    }
    
    // PnL 字段
    let pnl = null
    if (item.pnl != null) {
      pnl = typeof item.pnl === 'string' ? parseFloat(item.pnl) : Number(item.pnl)
      if (isNaN(pnl)) pnl = null
    } else if (item.totalPnl != null) {
      pnl = typeof item.totalPnl === 'string' ? parseFloat(item.totalPnl) : Number(item.totalPnl)
      if (isNaN(pnl)) pnl = null
    }
    
    // 头像
    const avatarUrl = item.avatarUrl || item.avatar || item.profilePhoto || item.headPic || null

    // 胜率
    let winRate = null
    if (item.winRate != null) {
      const winRateNum = typeof item.winRate === 'string'
        ? parseFloat(item.winRate.replace(/[+%]/g, ''))
        : Number(item.winRate)
      if (!isNaN(winRateNum)) {
        winRate = winRateNum
      }
    }

    // 多时间段ROI
    const roi_7d = item.roi7d != null ? (typeof item.roi7d === 'string' ? parseFloat(item.roi7d.replace(/[+%]/g, '')) : Number(item.roi7d)) : null
    const roi_30d = item.roi30d != null ? (typeof item.roi30d === 'string' ? parseFloat(item.roi30d.replace(/[+%]/g, '')) : Number(item.roi30d)) : null
    const roi_1y = item.roi1y != null ? (typeof item.roi1y === 'string' ? parseFloat(item.roi1y.replace(/[+%]/g, '')) : Number(item.roi1y)) : null
    const roi_2y = item.roi2y != null ? (typeof item.roi2y === 'string' ? parseFloat(item.roi2y.replace(/[+%]/g, '')) : Number(item.roi2y)) : null

    // 交易统计
    const totalTrades = item.totalTrades != null ? Number(item.totalTrades) : null
    const avgProfit = item.avgProfit != null ? Number(item.avgProfit) : null
    const avgLoss = item.avgLoss != null ? Number(item.avgLoss) : null
    const profitableTradesPct = item.profitableTradesPct != null ? Number(item.profitableTradesPct) : null

    return {
      traderId: String(traderId),
      handle: handle,
      roi: roi,
      pnl: pnl,
      followerCount: null,
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
 * 使用 Puppeteer 获取 Gate.io 90天ROI排行榜数据
 */
async function fetchGate90dRoi() {
  console.log('=== Gate.io 90天ROI排行榜数据抓取 ===')
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
    // 监听 Gate.io 相关的 API
    if (url.includes('gate.io') && (url.includes('api') || url.includes('leaderboard') || url.includes('copy-trading') || url.includes('trader'))) {
      try {
        const status = response.status()
        const data = await response.json().catch(() => null)
        
        if (!data) return
        
        capturedResponses.push({
          url: url.substring(0, 100),
          status,
          keys: Object.keys(data),
          code: data.code,
          hasData: !!data.data,
        })
        
        const isSuccess = status === 200 && (data.code === 0 || data.success === true)
        
        if (isSuccess && data.data) {
          const result = data.data
          
          let list = null
          
          if (Array.isArray(result)) {
            list = result
          } else if (result.list && Array.isArray(result.list)) {
            list = result.list
          } else if (result.items && Array.isArray(result.items)) {
            list = result.items
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
    console.log('正在访问 Gate.io Copy Trading 页面...')
    await page.goto('https://www.gate.io/copy-trading', {
      waitUntil: 'networkidle2',
      timeout: 90000,
    })

    console.log('等待页面加载...')
    await new Promise(resolve => setTimeout(resolve, 5000))

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight)
    })
    await new Promise(resolve => setTimeout(resolve, 2000))

    // 尝试查找并点击90天筛选
    console.log('尝试查找90天筛选器...')
    try {
      await page.waitForSelector('body', { timeout: 10000 })
      
      const selectors = [
        'button[class*="90"]',
        'button[class*="period"]',
        '[data-testid*="90"]',
        '[data-period="90"]',
        'button:has-text("90D")',
        'button:has-text("90")',
      ]
      
      let clicked = false
      for (const selector of selectors) {
        try {
          const elements = await page.$$(selector)
          for (const element of elements) {
            const text = await page.evaluate(el => el.textContent || '', element)
            if (text.includes('90') || text.includes('3M')) {
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
      console.log('=== 尝试直接调用 Gate.io API ===')
      
      if (capturedResponses.length > 0) {
        console.log('已捕获的响应:')
        capturedResponses.forEach((resp, i) => {
          console.log(`  ${i + 1}. ${resp.url}`)
          console.log(`     状态: ${resp.status}, 键: ${resp.keys.join(', ')}`)
        })
      }
      
      // 尝试常见的 Gate.io API 端点
      const apiEndpoints = [
        'https://api.gateio.ws/api/v4/copy_trading/leaderboard',
        'https://www.gate.io/api/v4/copy_trading/leaderboard',
      ]

      for (const apiUrl of apiEndpoints) {
        try {
          console.log(`尝试: ${apiUrl}`)
          
          const paramsList = [
            'period=90d&limit=100',
            'period=90&limit=100',
            'limit=100',
          ]

          for (const params of paramsList) {
            const fullUrl = `${apiUrl}?${params}`
            
            const response = await page.evaluate(async (fetchUrl) => {
              try {
                const res = await fetch(fetchUrl, {
                  method: 'GET',
                  headers: {
                    'Accept': 'application/json',
                    'Referer': 'https://www.gate.io/',
                    'Origin': 'https://www.gate.io',
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
              if ((data.code === 0 || data.success === true) && data.data) {
                const result = data.data
                if (Array.isArray(result) && result.length > 0) {
                  console.log(`✅ 成功获取数据: ${result.length} 条`)
                  capturedData = result
                  break
                } else if (result.list && Array.isArray(result.list) && result.list.length > 0) {
                  console.log(`✅ 成功获取数据: ${result.list.length} 条`)
                  capturedData = result.list
                  break
                }
              }
            }
          }
          
          if (capturedData && capturedData.length > 0) {
            break
          }
        } catch (e) {
          console.log(`⚠️ API 调用失败: ${apiUrl}`, e.message)
        }
      }
    }

    if (!capturedData || capturedData.length === 0) {
      console.log('\n等待更多 API 响应...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
      })
      await new Promise(resolve => setTimeout(resolve, 3000))
    }

    await browser.close()

    if (!capturedData || capturedData.length === 0) {
      throw new Error('无法获取数据，请检查网络连接或手动导出JSON数据')
    }

    console.log(`✅ 获取到 ${capturedData.length} 条原始数据`)
    
    const backupDir = join(process.cwd(), 'data', 'backup')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, `gate_90d_raw_${Date.now()}.json`), JSON.stringify(capturedData, null, 2))
    console.log(`原始数据已保存到: data/backup/gate_90d_raw_${Date.now()}.json`)

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

  const sourcesData = validData.map((item) => ({
    source: 'gate',
    source_type: 'leaderboard',
    source_trader_id: item.traderId,
    handle: item.handle,
    profile_url: item.avatarUrl,
    is_active: true,
    market_type: 'futures',
    source_kind: 'public',
    identity_type: 'trader'
  }))

  const snapshotsData = validData.map((item, index) => {
    const snapshot = {
      source: 'gate',
      source_trader_id: item.traderId,
      rank: index + 1,
      roi: item.roi,
      pnl: item.pnl,
      win_rate: item.winRate,
      roi_7d: item.roi_7d,
      roi_30d: item.roi_30d,
      roi_1y: item.roi_1y,
      roi_2y: item.roi_2y,
      total_trades: item.totalTrades,
      avg_profit: item.avgProfit,
      avg_loss: item.avgLoss,
      profitable_trades_pct: item.profitableTradesPct,
      captured_at: capturedAt,
    }
    return snapshot
  })

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
  console.log(`完成！共导入 ${validData.length} 条 Gate.io 90天ROI Top 100 交易员数据`)
}

/**
 * 主函数
 */
async function main() {
  try {
    const jsonPath = process.argv[2]
    
    let rawData = null
    
    if (jsonPath) {
      console.log(`从文件读取数据: ${jsonPath}`)
      const { readFileSync } = await import('fs')
      rawData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      
      if (Array.isArray(rawData)) {
        rawData = rawData
      } else if (rawData.data?.list) {
        rawData = rawData.data.list
      } else if (rawData.data && Array.isArray(rawData.data)) {
        rawData = rawData.data
      } else if (rawData.list) {
        rawData = rawData.list
      } else {
        throw new Error('无法识别 JSON 文件格式')
      }
      
      console.log(`从文件读取到 ${rawData.length} 条数据`)
    } else {
      rawData = await fetchGate90dRoi()
    }
    
    if (!rawData || rawData.length === 0) {
      console.error('未获取到数据')
      process.exit(1)
    }

    const normalizedData = normalizeData(rawData)
    console.log(`标准化后数据: ${normalizedData.length} 条`)
    if (normalizedData.length > 0) {
      console.log('示例数据:', JSON.stringify(normalizedData[0], null, 2))
    }

    await importToSupabase(normalizedData)
    
    console.log('')
    console.log('✅ 全部完成！')
  } catch (error) {
    console.error('❌ 错误:', error)
    process.exit(1)
  }
}

main()


import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// 只在需要导入数据库时才检查环境变量
let supabase = null
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
}

// 缓存已找到的可用端点
let cachedApiUrl = null

/**
 * 尝试多个可能的 API 端点
 */
async function findWorkingEndpoint(chain = 'bsc', page = 1, size = 25) {
  const possibleEndpoints = [
    `https://www.binance.com/bapi/web3/v1/public/leaderboard?chain=${chain}&page=${page}&size=${size}`,
    `https://www.binance.com/bapi/web3/v1/leaderboard?chain=${chain}&page=${page}&size=${size}`,
    `https://web3.binance.com/api/v1/leaderboard?chain=${chain}&page=${page}&size=${size}`,
    `https://web3.binance.com/bapi/web3/v1/public/leaderboard?chain=${chain}&page=${page}&size=${size}`,
    `https://www.binance.com/bapi/web3/v1/public/leaderboard?chain=${chain}&current=${page}&size=${size}`,
  ]

  for (const url of possibleEndpoints) {
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://web3.binance.com/',
          'Origin': 'https://web3.binance.com',
        },
      })

      if (response.ok) {
        const data = await response.json()
        if (data.code === '000000' && data.data && data.data.data && Array.isArray(data.data.data)) {
          return url.replace(`page=${page}`, 'page={page}').replace(`current=${page}`, 'current={page}')
        }
      }
    } catch (error) {
      // 继续尝试下一个
      continue
    }
  }
  
  return null
}

/**
 * 获取单页数据
 */
async function fetchPage(page = 1, size = 25, chain = 'bsc') {
  // 优先使用环境变量或缓存的端点
  let apiUrlTemplate = process.env.BINANCE_WEB3_API_URL || cachedApiUrl
  
  // 如果没有，尝试自动发现
  if (!apiUrlTemplate) {
    console.log('未找到 API 端点，正在自动发现...')
    apiUrlTemplate = await findWorkingEndpoint(chain, 1, size)
    if (apiUrlTemplate) {
      cachedApiUrl = apiUrlTemplate
      console.log(`✓ 找到可用端点: ${apiUrlTemplate}`)
    } else {
      throw new Error('无法找到可用的 API 端点。请运行: node scripts/find_binance_web3_api.mjs 来查找端点，或手动设置 BINANCE_WEB3_API_URL 环境变量')
    }
  }
  
  // 替换占位符（支持多种参数名）
  const apiUrl = apiUrlTemplate
    .replace('{page}', page)
    .replace('{pageNo}', page)
    .replace('{current}', page)
    .replace('{size}', size)
    .replace('{pageSize}', size)
  
  try {
    console.log(`正在获取第 ${page} 页...`)
    
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://web3.binance.com/',
        'Origin': 'https://web3.binance.com',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()
    
    // 检查响应格式（支持两种格式）
    if (data.code === '000000' && data.data) {
      // 格式1: data.data.data (嵌套数组)
      if (data.data.data && Array.isArray(data.data.data)) {
        return {
          success: true,
          data: data.data.data,
          pages: data.data.pages || data.data.totalPages || 1,
          current: data.data.current || data.data.pageNo || page,
          size: data.data.size || data.data.pageSize || size,
        }
      }
      // 格式2: data.data (直接数组)
      else if (Array.isArray(data.data)) {
        return {
          success: true,
          data: data.data,
          pages: data.pages || data.totalPages || 1,
          current: data.current || data.pageNo || page,
          size: data.size || data.pageSize || size,
        }
      }
    }
    
    throw new Error(`意外的响应格式: ${JSON.stringify(data).slice(0, 200)}`)
  } catch (error) {
    console.error(`获取第 ${page} 页失败:`, error.message)
    return {
      success: false,
      error: error.message,
      data: [],
    }
  }
}

/**
 * 批量获取所有页面数据
 */
async function fetchAllPages(chain = 'bsc', size = 25, maxPages = null) {
  console.log('开始批量获取 Binance Web3 Leaderboard 数据...')
  console.log('')
  
  // 先获取第一页以确定总页数
  const firstPage = await fetchPage(1, size, chain)
  
  if (!firstPage.success) {
    console.error('获取第一页失败，无法继续')
    return []
  }
  
  const totalPages = firstPage.pages || 1
  const maxPagesToFetch = maxPages || totalPages
  
  console.log(`总页数: ${totalPages}, 将获取: ${maxPagesToFetch} 页`)
  console.log('')
  
  const allData = [...firstPage.data]
  
  // 如果只有一页，直接返回
  if (totalPages <= 1) {
    console.log(`只获取到 1 页，共 ${allData.length} 条数据`)
    return allData
  }
  
  // 批量获取剩余页面
  const pagesToFetch = Math.min(maxPagesToFetch, totalPages)
  const allResults = []
  
  // 为了不触发限流，逐页获取并添加延迟
  const DELAY_MS = 300 // 每页之间的延迟（毫秒）
  
  for (let page = 2; page <= pagesToFetch; page++) {
    const result = await fetchPage(page, size, chain)
    if (result.success) {
      console.log(`✓ 第 ${page}/${pagesToFetch} 页: ${result.data.length} 条数据`)
      allResults.push(result.data)
    } else {
      console.log(`✗ 第 ${page}/${pagesToFetch} 页: 失败 - ${result.error}`)
      allResults.push([])
    }
    
    // 每页之间添加延迟，避免触发限流
    if (page < pagesToFetch) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS))
    }
  }
  
  const results = allResults
  
  // 合并所有数据
  results.forEach(pageData => {
    if (Array.isArray(pageData)) {
      allData.push(...pageData)
    }
  })
  
  console.log('')
  console.log(`✓ 完成！共获取 ${allData.length} 条数据（${pagesToFetch} 页）`)
  
  return allData
}

/**
 * 标准化数据格式
 */
function normalizeData(rawData) {
  return rawData.map((item, index) => {
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
    // 注意：不再获取 followers，因为所有 trader 的粉丝数只能来源 Arena 注册用户的关注
    // const followers = item.followerCount != null ? Number(item.followerCount) : (item.followers != null ? Number(item.followers) : null)
    const avatarUrl = item.addressLogo || item.userPhotoUrl || item.avatar || item.avatarUrl || item.profilePicture || null
    
    // 提取额外字段
    const winRate = item.winRate != null ? Number(item.winRate) : null
    const totalVolume = item.totalVolume != null ? Number(item.totalVolume) : null
    const avgBuyVolume = item.avgBuyVolume != null ? Number(item.avgBuyVolume) : null
    const lastActivity = item.lastActivity != null ? new Date(item.lastActivity).toISOString() : null

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
      encryptedUid: traderId,
      nickName: handle,
      roi: roi,
      pnl: pnl,
      followerCount: null, // 已废弃，不再从交易所 API 获取
      userPhotoUrl: avatarUrl,
      winRate: winRate,
      volume_90d: totalVolume,
      avg_buy_90d: avgBuyVolume,
      lastActivity: lastActivity,
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
 * 导入数据到 Supabase
 */
async function importToSupabase(normalizedData, sourceType = 'binance_web3') {
  if (!supabase) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to import data')
    return
  }
  // 过滤并排序：只保留有效的 ROI 数据，只保留前 100 条
  const validData = normalizedData
    .filter(item => {
      const roi = item.roi
      return roi != null && !isNaN(Number(roi)) && isFinite(Number(roi))
    })
    .sort((a, b) => Number(b.roi) - Number(a.roi))
    .slice(0, 100) // 只保留 ROI 前 100
  
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

  console.log(`筛选后条数: ${validData.length}`)

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
    market_type: 'web3',
    source_kind: 'public',
    identity_type: 'trader',
  }))

  // 转换为 trader_snapshots 数据（按 ROI 排序后分配排名）
  // 注意：不再保存 followers 字段，因为所有 trader 的粉丝数只能来源 Arena 注册用户的关注
  // 如果数据库表中有 followers 列且不允许 NULL，可以设置为 0，但代码中不再使用此值
  const snapshotsData = validData.map((item, index) => {
    const snapshot = {
      source: sourceType,
      source_trader_id: item.encryptedUid,
      rank: index + 1,
      roi: Number(item.roi),
      pnl: item.pnl != null ? Number(item.pnl) : null,
      win_rate: item.winRate != null ? Number(item.winRate) : null,
      volume_90d: item.volume_90d != null ? Number(item.volume_90d) : null,
      avg_buy_90d: item.avg_buy_90d != null ? Number(item.avg_buy_90d) : null,
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
  console.log(`完成！共导入 ${validData.length} 条 Binance Web3 交易员数据`)
}

/**
 * 主函数
 */
async function main() {
  const chain = process.argv[2] || 'bsc' // 默认 BSC
  const maxPages = process.argv[3] ? parseInt(process.argv[3]) : null // 可选：限制页数（用于测试）
  const saveOnly = process.argv.includes('--save-only') // 只保存不导入
  
  console.log('=== Binance Web3 Leaderboard 批量获取工具 ===')
  console.log('')
  
  // 检查 API URL 环境变量
  if (!process.env.BINANCE_WEB3_API_URL) {
    console.log('⚠️  警告: 未设置 BINANCE_WEB3_API_URL 环境变量')
    console.log('   将使用默认 API URL（可能不正确）')
    console.log('')
    console.log('   请从浏览器开发者工具中找到正确的 API 端点：')
    console.log('   1. 打开 https://web3.binance.com/en/leaderboard?chain=bsc')
    console.log('   2. 按 F12 打开开发者工具')
    console.log('   3. 切换到 Network 标签')
    console.log('   4. 刷新页面，查找包含 leaderboard 的 API 请求')
    console.log('   5. 复制完整的 URL，设置环境变量：')
    console.log('      export BINANCE_WEB3_API_URL="<复制的URL>"')
    console.log('')
    console.log('   或者直接修改脚本中的 apiUrl 变量')
    console.log('')
  }
  
  // 获取所有页面数据
  const allData = await fetchAllPages(chain, 25, maxPages)
  
  if (allData.length === 0) {
    console.error('未获取到任何数据')
    process.exit(1)
  }
  
  // 保存到文件
  const outputPath = `binance_web3_all_pages_${Date.now()}.json`
  writeFileSync(outputPath, JSON.stringify(allData, null, 2))
  console.log(`数据已保存到: ${outputPath}`)
  console.log('')
  
  if (saveOnly) {
    console.log('--save-only 模式：跳过数据库导入')
    return
  }
  
  // 标准化数据
  console.log('标准化数据...')
  const normalizedData = normalizeData(allData)
  console.log(`标准化后数据条数: ${normalizedData.length}`)
  console.log('')
  
  // 导入到 Supabase
  console.log('导入到 Supabase...')
  await importToSupabase(normalizedData, 'binance_web3')
}

// 运行
main().catch((error) => {
  console.error('执行失败:', error)
  process.exit(1)
})


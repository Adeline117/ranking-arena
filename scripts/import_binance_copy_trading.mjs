import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/**
 * 从 API 获取数据
 */
async function fetchFromAPI(apiUrl) {
  try {
    console.log(`正在从 API 获取数据: ${apiUrl}`)
    
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.binance.com/',
        'Origin': 'https://www.binance.com',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()
    
    // 支持多种响应格式
    if (data.code === '000000' && data.data) {
      return Array.isArray(data.data) ? data.data : (data.data.data || data.data.list || [])
    } else if (Array.isArray(data)) {
      return data
    } else if (data.data && Array.isArray(data.data)) {
      return data.data
    } else {
      throw new Error('无法识别响应格式')
    }
  } catch (error) {
    console.error('从 API 获取数据失败:', error.message)
    return null
  }
}

/**
 * 标准化数据格式
 */
function normalizeData(rawData) {
  if (!Array.isArray(rawData)) {
    throw new Error('数据必须是数组格式')
  }

  return rawData.map((item, index) => {
    // 币安跟单交易可能使用的字段名
    const traderId = item.uid || item.userId || item.traderId || item.encryptedUid || item.id || String(index)
    const handle = item.nickName || item.nickname || item.name || item.username || item.handle || null
    
    // ROI 字段可能的名字
    const roi = item.roi90d || item.roi || item.return90d || item.returnRate90d || item.performance90d || 
                item.returnRate || item.performance || item.profitRate || 0
    
    // PnL 字段
    const pnl = item.pnl90d || item.pnl || item.profit90d || item.profit || item.realizedPnl || null
    
    // 关注者
    const followers = item.followerCount || item.followers || item.copiers || item.copyCount || 0
    
    // 头像
    const avatarUrl = item.avatarUrl || item.avatar || item.userPhotoUrl || item.profilePicture || null

    // 胜率
    const winRate = item.winRate90d || item.winRate || item.winningRate || null
    
    // 交易量
    const totalVolume = item.volume90d || item.totalVolume90d || item.volume || item.totalVolume || null
    
    // 平均买入
    const avgBuyVolume = item.avgBuyVolume90d || item.avgBuyVolume || item.avgBuy || null

    return {
      encryptedUid: traderId,
      nickName: handle,
      roi: Number(roi),
      pnl: pnl != null ? Number(pnl) : null,
      followerCount: Number(followers),
      userPhotoUrl: avatarUrl,
      winRate: winRate != null ? Number(winRate) : null,
      volume_90d: totalVolume != null ? Number(totalVolume) : null,
      avg_buy_90d: avgBuyVolume != null ? Number(avgBuyVolume) : null,
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
  })

  const capturedAt = new Date().toISOString()

  const sourcesData = validData.map(item => ({
    source: sourceType,
    source_type: 'leaderboard',
    source_trader_id: item.encryptedUid,
    handle: item.nickName && item.nickName.trim() !== '' ? item.nickName : null, // 只有当有真实名称时才设置
    profile_url: item.userPhotoUrl || null,
    is_active: true,
    market_type: 'futures', // 币安跟单交易通常是期货
    source_kind: 'public',
    identity_type: 'trader',
  }))

  // 只包含基本字段
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
 * 主函数
 */
async function main() {
  const jsonPath = process.argv[2]
  const apiUrl = process.env.BINANCE_COPY_TRADING_API_URL

  let rawData = null

  if (jsonPath) {
    // 从 JSON 文件导入
    console.log('=== 从 JSON 文件导入币安跟单交易数据 ===')
    console.log('')
    console.log(`读取文件: ${jsonPath}`)
    
    try {
      rawData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      
      // 支持多种 JSON 格式
      if (rawData.code === '000000' && rawData.data) {
        rawData = Array.isArray(rawData.data) ? rawData.data : (rawData.data.data || rawData.data.list || [])
      } else if (rawData.data && Array.isArray(rawData.data)) {
        rawData = rawData.data
      } else if (!Array.isArray(rawData)) {
        throw new Error('无法识别 JSON 格式')
      }
      
      console.log(`✓ 文件读取成功，共 ${rawData.length} 条数据`)
    } catch (error) {
      console.error('读取文件失败:', error.message)
      process.exit(1)
    }
  } else if (apiUrl) {
    // 从 API 获取
    console.log('=== 从 API 导入币安跟单交易数据 ===')
    console.log('')
    rawData = await fetchFromAPI(apiUrl)
    
    if (!rawData || rawData.length === 0) {
      console.error('未获取到数据')
      process.exit(1)
    }
    
    // 保存到文件
    const outputPath = `binance_copy_trading_${Date.now()}.json`
    writeFileSync(outputPath, JSON.stringify(rawData, null, 2))
    console.log(`数据已保存到: ${outputPath}`)
  } else {
    console.error('用法:')
    console.error('  1. 从 JSON 文件导入:')
    console.error('     node scripts/import_binance_copy_trading.mjs <json-file>')
    console.error('')
    console.error('  2. 从 API 导入:')
    console.error('     export BINANCE_COPY_TRADING_API_URL="<api-url>"')
    console.error('     node scripts/import_binance_copy_trading.mjs')
    console.error('')
    console.error('  如何获取 API URL:')
    console.error('    1. 打开 https://www.binance.com/zh-CN/copy-trading')
    console.error('    2. 按 F12 打开开发者工具')
    console.error('    3. 切换到 Network 标签')
    console.error('    4. 刷新页面，查找包含 leaderboard 或 trader 的 API 请求')
    console.error('    5. 复制完整的 URL')
    process.exit(1)
  }

  console.log('')
  console.log('标准化数据...')
  const normalizedData = normalizeData(rawData)
  console.log(`✓ 标准化后: ${normalizedData.length} 条`)
  console.log('')

  console.log('导入到 Supabase...')
  await importToSupabase(normalizedData, 'binance')
  
  console.log('')
  console.log('✅ 全部完成！')
}

main().catch((error) => {
  console.error('执行失败:', error)
  process.exit(1)
})




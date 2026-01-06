import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

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
    const traderId = item.leadPortfolioId
    const handle = item.nickname || null
    
    // roi 字段已经是90天ROI（百分比形式）
    const roi = item.roi != null ? Number(item.roi) : 0
    
    // PnL 字段
    const pnl = item.pnl != null ? Number(item.pnl) : null
    
    // 关注者
    const followers = item.currentCopyCount || 0
    
    // 头像
    const avatarUrl = item.avatarUrl || null

    // 胜率
    const winRate = item.winRate != null ? Number(item.winRate) : null

    return {
      encryptedUid: String(traderId),
      nickName: handle,
      roi: roi,
      pnl: pnl,
      followerCount: Number(followers),
      userPhotoUrl: avatarUrl,
      winRate: winRate,
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
  console.log('')

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
    win_rate: item.winRate != null ? Number(item.winRate) : null,
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
  try {
    // 从命令行参数获取JSON文件路径，或者使用默认路径
    const jsonPath = process.argv[2] || 'binance_copy_trading_data.json'
    
    console.log('=== 币安90天ROI排行榜数据导入 ===')
    console.log(`从文件读取: ${jsonPath}`)
    console.log('')
    
    // 读取JSON文件
    const fileContent = readFileSync(jsonPath, 'utf-8')
    const jsonData = JSON.parse(fileContent)
    
    // 提取list数组
    let rawData = []
    if (jsonData.data && jsonData.data.list) {
      rawData = jsonData.data.list
    } else if (Array.isArray(jsonData)) {
      rawData = jsonData
    } else {
      throw new Error('无法解析JSON数据格式')
    }
    
    console.log(`读取到 ${rawData.length} 条数据`)
    console.log('')
    
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


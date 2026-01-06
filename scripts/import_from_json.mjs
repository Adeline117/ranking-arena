import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'
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
  // .env 文件不存在
}

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
  // 支持多种格式
  let dataArray = rawData
  if (rawData.code === '000000' && rawData.data && rawData.data.data) {
    dataArray = rawData.data.data
  } else if (rawData.data && Array.isArray(rawData.data)) {
    dataArray = rawData.data
  } else if (!Array.isArray(rawData)) {
    throw new Error('数据格式不正确')
  }

  return dataArray.map((item, index) => {
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
    .slice(0, 100) // 只保留 ROI 前 100

  console.log(`筛选后条数（ROI Top 100）: ${validData.length}`)

  if (validData.length === 0) {
    console.error('没有有效的数据可导入')
    return
  }

  const capturedAt = new Date().toISOString()

  const sourcesData = validData.map(item => ({
    source: sourceType,
    source_type: 'leaderboard',
    source_trader_id: item.encryptedUid,
    handle: item.nickName && item.nickName.trim() !== '' ? item.nickName : null, // 只有当有真实名称时才设置，否则为 null
    profile_url: item.userPhotoUrl || null,
    is_active: true,
    market_type: 'web3',
    source_kind: 'public',
    identity_type: 'trader',
  }))

  // 只包含基本字段（根据数据库表结构）
  const snapshotsData = validData.map((item, index) => ({
    source: sourceType,
    source_trader_id: item.encryptedUid,
    rank: index + 1,
    roi: Number(item.roi),
    pnl: item.pnl != null ? Number(item.pnl) : null,
    followers: item.followerCount != null ? Number(item.followerCount) : null,
    captured_at: capturedAt,
    // 注意：win_rate, volume_90d, avg_buy_90d 等字段可能不存在于数据库表中
    // 如果需要这些字段，请先在数据库中创建相应的列
  }))

  const BATCH_SIZE = 100
  let sourcesSuccess = 0
  let snapshotsSuccess = 0

  // 去重 trader_sources（基于 source, source_type, source_trader_id）
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
  console.log(`✅ 完成！共导入 ${validData.length} 条数据`)
}

/**
 * 主函数
 */
async function main() {
  const jsonPath = process.argv[2]
  
  if (!jsonPath) {
    console.error('用法: node scripts/import_from_json.mjs <json-file>')
    console.error('')
    console.error('JSON 文件格式可以是：')
    console.error('1. { code: "000000", data: { data: [...] } }')
    console.error('2. { data: [...] }')
    console.error('3. [...]')
    process.exit(1)
  }

  console.log('=== 从 JSON 文件导入 Binance Web3 数据 ===')
  console.log('')
  console.log(`读取文件: ${jsonPath}`)
  
  try {
    const rawData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    console.log(`✓ 文件读取成功`)
    console.log('')
    
    console.log('标准化数据...')
    const normalizedData = normalizeData(rawData)
    console.log(`✓ 标准化后: ${normalizedData.length} 条`)
    console.log('')
    
    console.log('导入到 Supabase...')
    await importToSupabase(normalizedData, 'binance_web3')
    
    console.log('')
    console.log('✅ 全部完成！')
  } catch (error) {
    console.error('❌ 导入失败:', error.message)
    process.exit(1)
  }
}

main()


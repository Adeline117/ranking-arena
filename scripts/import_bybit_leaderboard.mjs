import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
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

// 支持从 JSON 文件导入（推荐方式）
// 使用方式: node scripts/import_bybit_leaderboard.mjs <json-file>
// 或者: node scripts/import_bybit_leaderboard.mjs
const jsonPath = process.argv[2]

/**
 * 从 Bybit API 获取交易员排行榜数据（可能不稳定）
 */
async function fetchBybitLeaderboard() {
  try {
    // Bybit Copy Trading Leaderboard API
    // 注意：Bybit 的公开 API 可能需要认证，这里提供一个基础实现
    const url = 'https://api.bybit.com/v5/copy-trading/leaderboard/select-leader'
    const params = new URLSearchParams({
      category: 'linear',
      period: '30d',
      statType: 'ROI',
      limit: '100',
    })

    const response = await fetch(`${url}?${params}`, {
      headers: {
        'Accept': 'application/json',
      },
    })
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data = await response.json()
    
    if (data.retCode !== 0) {
      throw new Error(`Bybit API error: ${data.retMsg || 'Unknown error'}`)
    }

    return data.result?.list || data.result?.leaderList || []
  } catch (error) {
    console.error('Error fetching Bybit leaderboard:', error.message)
    throw error
  }
}

/**
 * 导入 Bybit 交易员数据到 Supabase
 */
async function importBybitLeaderboard() {
  try {
    let traders = []
    
    if (jsonPath) {
      // 从 JSON 文件导入（推荐方式）
      console.log(`从文件读取数据: ${jsonPath}`)
      const rawData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      
      // 支持多种 JSON 格式
      if (Array.isArray(rawData)) {
        traders = rawData
      } else if (rawData.result?.list) {
        traders = rawData.result.list
      } else if (rawData.result?.leaderList) {
        traders = rawData.result.leaderList
      } else if (rawData.list) {
        traders = rawData.list
      } else {
        throw new Error('无法识别 JSON 文件格式')
      }
      
      console.log(`从文件读取到 ${traders.length} 条数据`)
    } else {
      // 从 API 获取（可能不稳定）
      console.log('开始从 API 获取 Bybit 交易员排行榜数据...')
      console.log('注意：如果 API 失败，请先手动导出 JSON 数据，然后使用: node scripts/import_bybit_leaderboard.mjs <json-file>')
      traders = await fetchBybitLeaderboard()
    }
    
    if (!traders || traders.length === 0) {
      console.error('未获取到交易员数据')
      return
    }

    console.log(`获取到 ${traders.length} 条交易员数据`)
    console.log('示例数据:', JSON.stringify(traders[0], null, 2))

    // 过滤并排序：只保留有效的 ROI 数据
    // Bybit 数据字段可能包括: roi30d, roi7d, roi, totalRoi, returnRate30d 等
    const validData = traders
      .filter(item => {
        const roi = item?.roi30d || item?.roi7d || item?.roi || item?.totalRoi || item?.returnRate30d || item?.stat?.roi
        return roi != null && !isNaN(Number(roi)) && Number(roi) !== 0
      })
      .map(item => {
        const roi = Number(item?.roi30d || item?.roi7d || item?.roi || item?.totalRoi || item?.returnRate30d || item?.stat?.roi || 0)
        return { ...item, _calculatedRoi: roi }
      })
      .sort((a, b) => b._calculatedRoi - a._calculatedRoi)
      .slice(0, 100)

    console.log(`筛选后条数（ROI Top 100）: ${validData.length}`)

    if (validData.length === 0) {
      console.error('没有有效的数据可导入')
      return
    }

    const capturedAt = new Date().toISOString()

    // 转换为 trader_sources 数据
    // Bybit 数据字段可能包括: uid, leaderUid, leaderBoardId, userId, nickName, username, userName, avatar, avatarUrl
    const sourcesData = validData.map(item => {
      const traderId = item.uid || item.leaderUid || item.leaderBoardId || item.userId || String(item.id || '')
      const handle = item.nickName || item.username || item.userName || item.name || null
      const avatarUrl = item.avatar || item.avatarUrl || item.profilePicture || null
      
      return {
        source: 'bybit',
        source_type: 'leaderboard',
        source_trader_id: String(traderId),
        handle: handle,
        profile_url: avatarUrl,
        is_active: true,
        market_type: 'futures',
        source_kind: 'public',
        identity_type: 'trader'
      }
    })

    // 转换为 trader_snapshots 数据（rank 重新计算为 1-100）
    const snapshotsData = validData.map((item, index) => {
      const roi = item._calculatedRoi
      const pnl = item?.totalPnl != null ? Number(item.totalPnl) : (item?.pnl != null ? Number(item.pnl) : null)
      const followers = item?.copierNum != null ? Number(item.copierNum) : (item?.followerCount != null ? Number(item.followerCount) : (item?.copiers != null ? Number(item.copiers) : null))
      const traderId = item.uid || item.leaderUid || item.leaderBoardId || item.userId || String(item.id || '')
      
      return {
        source: 'bybit',
        source_trader_id: String(traderId),
        rank: index + 1,
        roi: roi,
        pnl: pnl,
        followers: followers,
        captured_at: capturedAt
      }
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
    console.log(`完成！共导入 ${validData.length} 条 Bybit ROI Top 100 交易员数据`)
  } catch (error) {
    console.error('导入失败:', error)
    process.exit(1)
  }
}

// 运行导入
importBybitLeaderboard()

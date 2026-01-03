import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const jsonPath = process.argv[2]
if (!jsonPath) {
  console.error('Usage: node scripts/import_binance_leaderboard.mjs <json-file>')
  process.exit(1)
}

const rawData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
console.log(`原始数据条数: ${rawData.length}`)

// 过滤并排序：只保留 ROI Top 100
const validData = rawData
  .filter(item => item.roi != null && !isNaN(Number(item.roi)))
  .sort((a, b) => Number(b.roi) - Number(a.roi))
  .slice(0, 100)

console.log(`筛选后条数（ROI Top 100）: ${validData.length}`)

const capturedAt = new Date().toISOString()

// 转换为 trader_sources 数据
const sourcesData = validData.map(item => ({
  source: 'binance',
  source_type: 'leaderboard',
  source_trader_id: item.encryptedUid,
  handle: item.nickName || null,
  profile_url: item.userPhotoUrl || null,
  is_active: true,
  market_type: 'futures',
  source_kind: 'public',
  identity_type: 'trader'
}))

// 转换为 trader_snapshots 数据（rank 重新计算为 1-100）
const snapshotsData = validData.map((item, index) => ({
  source: 'binance',
  source_trader_id: item.encryptedUid,
  rank: index + 1,
  roi: Number(item.roi),
  pnl: item.pnl != null ? Number(item.pnl) : null,
  followers: item.followerCount != null ? Number(item.followerCount) : null,
  source_updated_at: item.updateTime != null ? new Date(item.updateTime).toISOString() : null,
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
  }
}

console.log(`trader_snapshots 导入: 成功 ${snapshotsSuccess}, 失败 ${snapshotsError}`)
console.log(`完成！共导入 ${validData.length} 条 ROI Top 100 交易员数据`)


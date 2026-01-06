import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/**
 * 只保留 ROI 前 100 的交易员数据
 */
async function keepOnlyTop100() {
  console.log('=== 清理数据，只保留 ROI 前 100 ===')
  console.log('')

  try {
    // 1. 获取最新的 captured_at
    const { data: latestSnapshot, error: latestError } = await supabase
      .from('trader_snapshots')
      .select('captured_at')
      .eq('source', 'binance_web3')
      .order('captured_at', { ascending: false })
      .limit(1)
      .single()

    if (latestError || !latestSnapshot) {
      console.error('无法获取最新快照:', latestError)
      return
    }

    console.log(`最新快照时间: ${latestSnapshot.captured_at}`)
    console.log('')

    // 2. 获取该批次的所有数据，按 ROI 排序
    const { data: allSnapshots, error: snapshotsError } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, rank, roi')
      .eq('source', 'binance_web3')
      .eq('captured_at', latestSnapshot.captured_at)
      .order('roi', { ascending: false })

    if (snapshotsError) {
      console.error('获取快照数据失败:', snapshotsError)
      return
    }

    console.log(`当前数据总数: ${allSnapshots.length}`)

    if (allSnapshots.length <= 100) {
      console.log('数据量已 <= 100，无需清理')
      return
    }

    // 3. 获取前 100 的 source_trader_id
    const top100Ids = allSnapshots.slice(0, 100).map(s => s.source_trader_id)
    console.log(`将保留前 100 条数据`)
    console.log('')

    // 4. 删除不在前 100 的 snapshots
    const { error: deleteSnapshotsError } = await supabase
      .from('trader_snapshots')
      .delete()
      .eq('source', 'binance_web3')
      .eq('captured_at', latestSnapshot.captured_at)
      .not('source_trader_id', 'in', `(${top100Ids.map(id => `"${id}"`).join(',')})`)

    if (deleteSnapshotsError) {
      console.error('删除多余快照失败:', deleteSnapshotsError)
    } else {
      console.log('✅ 已删除多余的快照数据')
    }

    // 5. 删除不在前 100 的 sources（分批删除，避免 SQL 语句过长）
    const { data: allSources } = await supabase
      .from('trader_sources')
      .select('source_trader_id')
      .eq('source', 'binance_web3')

    if (allSources) {
      const sourcesToDelete = allSources
        .filter(s => !top100Ids.includes(s.source_trader_id))
        .map(s => s.source_trader_id)

      if (sourcesToDelete.length > 0) {
        // 检查这些 source 是否在其他快照中使用
        const { data: otherSnapshots } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id')
          .eq('source', 'binance_web3')
          .in('source_trader_id', sourcesToDelete)

        const usedIds = new Set(otherSnapshots?.map(s => s.source_trader_id) || [])
        const safeToDelete = sourcesToDelete.filter(id => !usedIds.has(id))

        if (safeToDelete.length > 0) {
          // 分批删除，每批 50 个
          const BATCH_SIZE = 50
          let deletedCount = 0
          
          for (let i = 0; i < safeToDelete.length; i += BATCH_SIZE) {
            const batch = safeToDelete.slice(i, i + BATCH_SIZE)
            const { error: deleteSourcesError } = await supabase
              .from('trader_sources')
              .delete()
              .eq('source', 'binance_web3')
              .in('source_trader_id', batch)

            if (deleteSourcesError) {
              console.error(`删除批次 ${Math.floor(i / BATCH_SIZE) + 1} 失败:`, deleteSourcesError)
            } else {
              deletedCount += batch.length
            }
          }
          
          if (deletedCount > 0) {
            console.log(`✅ 已删除 ${deletedCount} 条多余的源数据`)
          }
        } else {
          console.log('所有源数据都在使用中，无需删除')
        }
      }
    }

    console.log('')
    console.log('✅ 完成！现在只保留 ROI 前 100 的交易员')
  } catch (error) {
    console.error('执行失败:', error)
    process.exit(1)
  }
}

keepOnlyTop100()


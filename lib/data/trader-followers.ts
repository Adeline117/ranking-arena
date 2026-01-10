/**
 * Trader 粉丝数管理
 * 所有 trader 的粉丝数只能来源 Arena 注册用户的关注
 */

import { SupabaseClient } from '@supabase/supabase-js'

/**
 * 获取单个 trader 的 Arena 粉丝数
 * @param supabase Supabase 客户端
 * @param traderId Trader ID（source_trader_id）
 * @returns 粉丝数
 */
export async function getTraderArenaFollowersCount(
  supabase: SupabaseClient,
  traderId: string
): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('trader_follows')
      .select('*', { count: 'exact', head: true })
      .eq('trader_id', traderId)

    if (error) {
      // 检查是否有实际的错误内容，避免记录空错误对象 {}
      const hasErrorContent = !!(error.message || error.code || error.hint || error.details)
      
      // 特殊处理：如果是表不存在错误（code 42P01 或 relation does not exist），这是真正的错误
      const isTableNotFound = error.code === '42P01' || 
                                (error.message && typeof error.message === 'string' && 
                                 error.message.toLowerCase().includes('does not exist'))
      
      if (hasErrorContent || isTableNotFound) {
        console.error(`[trader-followers] 获取 trader ${traderId} 粉丝数失败:`, {
          error,
          message: error.message,
          code: error.code,
          hint: error.hint,
          details: error.details,
        })
        
        // 如果是表不存在，提示需要运行 SQL 脚本
        if (isTableNotFound) {
          console.warn(`[trader-followers] trader_follows 表不存在，请运行 scripts/setup_trader_follows.sql 创建表`)
        }
      } else {
        // 空错误对象 {}，不记录错误，可能是正常的数据库响应
      }
      return 0
    }

    return count || 0
  } catch (error: any) {
    // 检查是否有实际的错误内容，避免记录空错误对象 {}
    const hasErrorContent = !!(error?.message || error?.code || error?.hint || error?.details)
    
    // 特殊处理：如果是表不存在错误（code 42P01 或 relation does not exist），这是真正的错误
    const isTableNotFound = error?.code === '42P01' || 
                            (error?.message && typeof error.message === 'string' && 
                             error.message.toLowerCase().includes('does not exist'))
    
    if (hasErrorContent || isTableNotFound) {
      console.error(`[trader-followers] 获取 trader ${traderId} 粉丝数异常:`, {
        error,
        message: error?.message,
        code: error?.code,
        hint: error?.hint,
        details: error?.details,
      })
      
      // 如果是表不存在，提示需要运行 SQL 脚本
      if (isTableNotFound) {
        console.warn(`[trader-followers] trader_follows 表不存在，请运行 scripts/setup_trader_follows.sql 创建表`)
      }
    } else {
      // 空错误对象 {}，不记录错误，可能是正常的异常情况
    }
    return 0
  }
}

/**
 * 批量获取多个 trader 的 Arena 粉丝数
 * @param supabase Supabase 客户端
 * @param traderIds Trader ID 数组
 * @returns Map<traderId, followersCount>
 */
export async function getTradersArenaFollowersCount(
  supabase: SupabaseClient,
  traderIds: string[]
): Promise<Map<string, number>> {
  const resultMap = new Map<string, number>()

  if (!traderIds || traderIds.length === 0) {
    return resultMap
  }

  try {
    // 分批查询，避免单次查询过多
    const BATCH_SIZE = 100
    for (let i = 0; i < traderIds.length; i += BATCH_SIZE) {
      const batch = traderIds.slice(i, i + BATCH_SIZE)

      // 使用分组查询统计每个 trader 的粉丝数（更高效）
      // 注意：Supabase 的 count 功能可能不支持分组，所以使用手动统计
      const { data, error } = await supabase
        .from('trader_follows')
        .select('trader_id')
        .in('trader_id', batch)

      if (error) {
        // 检查是否有实际的错误内容，避免记录空错误对象 {}
        const hasErrorContent = !!(error.message || error.code || error.hint || error.details)
        
        // 特殊处理：如果是表不存在错误（code 42P01 或 relation does not exist），这是真正的错误
        const isTableNotFound = error.code === '42P01' || 
                                (error.message && typeof error.message === 'string' && 
                                 error.message.toLowerCase().includes('does not exist'))
        
        if (hasErrorContent || isTableNotFound) {
          const batchNum = Math.floor(i / BATCH_SIZE) + 1
          console.error(`[trader-followers] 批量获取粉丝数失败 (batch ${batchNum}):`, {
            error,
            message: error.message,
            code: error.code,
            hint: error.hint,
            details: error.details,
            batchNum,
          })
          
          // 如果是表不存在，提示需要运行 SQL 脚本（只提示一次）
          if (isTableNotFound && i === 0) {
            console.warn(`[trader-followers] trader_follows 表不存在，请运行 scripts/setup_trader_follows.sql 创建表`)
          }
        } else {
          // 空错误对象 {}，不记录错误，可能是正常的数据库响应
        }
        // 初始化这批 trader 的粉丝数为 0（无论是否有错误）
        batch.forEach(id => resultMap.set(id, 0))
        continue
      }

      // 统计每个 trader 的粉丝数
      const counts = new Map<string, number>()
      if (data && Array.isArray(data)) {
        data.forEach((row: { trader_id: string }) => {
          const currentCount = counts.get(row.trader_id) || 0
          counts.set(row.trader_id, currentCount + 1)
        })
      }

      // 更新结果 map（包括没有粉丝的 trader，设为 0）
      batch.forEach(id => {
        resultMap.set(id, counts.get(id) || 0)
      })
    }
  } catch (error: any) {
    // 检查是否有实际的错误内容，避免记录空错误对象 {}
    const hasErrorContent = !!(error?.message || error?.code || error?.hint || error?.details)
    if (hasErrorContent) {
      console.error('[trader-followers] 批量获取粉丝数异常:', error)
    } else {
      // 空错误对象 {}，不记录错误，可能是正常的异常情况
    }
    // 初始化所有 trader 的粉丝数为 0（无论是否有错误）
    traderIds.forEach(id => resultMap.set(id, 0))
  }

  return resultMap
}


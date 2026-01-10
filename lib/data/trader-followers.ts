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
      // 严格检查每个字段，确保它们不是空值
      const hasMessage = error.message && typeof error.message === 'string' && error.message.trim() !== ''
      const hasCode = error.code && (typeof error.code === 'string' || typeof error.code === 'number')
      const hasHint = error.hint && typeof error.hint === 'string' && error.hint.trim() !== ''
      
      // details 可能是对象，需要检查是否为空对象
      let hasDetails = false
      if (error.details) {
        if (typeof error.details === 'string' && error.details.trim() !== '') {
          hasDetails = true
        } else if (typeof error.details === 'object' && error.details !== null) {
          const detailsKeys = Object.keys(error.details)
          if (detailsKeys.length > 0) {
            // 检查对象中是否有非空值
            hasDetails = detailsKeys.some(key => {
              const value = (error.details as any)[key]
              if (value === null || value === undefined || value === '') {
                return false
              }
              if (typeof value === 'object') {
                return Object.keys(value).length > 0
              }
              return true
            })
          }
          // 如果 detailsKeys.length === 0，hasDetails 保持为 false（空对象）
        }
      }
      
      const hasErrorContent = hasMessage || hasCode || hasHint || hasDetails
      
      // 特殊处理：如果是表不存在错误（code 42P01 或 relation does not exist），这是真正的错误
      const isTableNotFound = error.code === '42P01' || 
                                (hasMessage && error.message.toLowerCase().includes('does not exist'))
      
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
        // 空错误对象 {}，不记录错误，可能是正常的数据库响应（例如查询无结果）
        // 这是正常的，不需要记录
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
        // 综合检查错误对象是否为空（使用多种方法确保可靠性）
        // 最直接的方法：先检查 JSON.stringify 是否等于 '{}'
        let isEmpty = false
        try {
          const errorJson = JSON.stringify(error)
          if (errorJson === '{}') {
            isEmpty = true
          }
        } catch (e) {
          // JSON.stringify 可能失败（如果对象包含不可序列化的属性），继续使用其他方法
        }
        
        // 如果 JSON.stringify 检查没有确定为空，再检查所有可枚举属性是否都是空的
        if (!isEmpty) {
          const errorKeys = Object.keys(error || {})
          if (errorKeys.length === 0) {
            isEmpty = true
          } else {
            // 检查所有属性值是否都是空的
            const hasAnyValue = errorKeys.some(key => {
              const value = (error as any)[key]
              // 跳过函数、Symbol 等不可序列化的值
              if (typeof value === 'function' || typeof value === 'symbol') {
                return false
              }
              // 检查基本类型值
              if (value === null || value === undefined || value === '') {
                return false
              }
              // 检查对象值
              if (typeof value === 'object') {
                try {
                  const valueJson = JSON.stringify(value)
                  return valueJson !== '{}' && valueJson !== 'null'
                } catch (e) {
                  return false
                }
              }
              return true
            })
            if (!hasAnyValue) {
              isEmpty = true
            }
          }
        }
        
        // 检查标准 Supabase 错误字段（即使 isEmpty 为 false，也要确保这些字段真的存在）
        const hasMessage = error.message && typeof error.message === 'string' && error.message.trim() !== ''
        const hasCode = error.code !== undefined && error.code !== null && error.code !== '' && 
                       (typeof error.code === 'string' || typeof error.code === 'number')
        const hasHint = error.hint && typeof error.hint === 'string' && error.hint.trim() !== ''
        
        // details 可能是对象，需要检查是否为空对象
        let hasDetails = false
        if (error.details !== undefined && error.details !== null) {
          if (typeof error.details === 'string' && error.details.trim() !== '') {
            hasDetails = true
          } else if (typeof error.details === 'object') {
            try {
              const detailsJson = JSON.stringify(error.details)
              if (detailsJson !== '{}' && detailsJson !== 'null') {
                const detailsKeys = Object.keys(error.details)
                if (detailsKeys.length > 0) {
                  hasDetails = detailsKeys.some(key => {
                    const value = (error.details as any)[key]
                    if (value === null || value === undefined || value === '') {
                      return false
                    }
                    if (typeof value === 'object') {
                      try {
                        return JSON.stringify(value) !== '{}' && JSON.stringify(value) !== 'null'
                      } catch (e) {
                        return false
                      }
                    }
                    return true
                  })
                }
              }
            } catch (e) {
              // JSON.stringify 失败，忽略
            }
          }
        }
        
        const hasErrorContent = hasMessage || hasCode || hasHint || hasDetails
        
        // 特殊处理：如果是表不存在错误（code 42P01 或 relation does not exist），这是真正的错误
        // 但要确保 code 或 message 确实存在且非空
        const isTableNotFound = (hasCode && error.code === '42P01') || 
                                (hasMessage && typeof error.message === 'string' && error.message.toLowerCase().includes('does not exist'))
        
        // 关键修复：如果 isEmpty 为 true，或者既没有错误内容也不是表不存在错误，则不记录错误
        if (isEmpty || (!hasErrorContent && !isTableNotFound)) {
          // 空错误对象 {}，不是真正的错误，继续处理（可能是正常的查询无结果）
          // 初始化这批 trader 的粉丝数为 0
          batch.forEach(id => resultMap.set(id, 0))
          continue
        }
        
        // 只有在确实有错误内容时才记录错误
        const batchNum = Math.floor(i / BATCH_SIZE) + 1
        
        // 如果是表不存在错误，使用 warn 而不是 error（因为这是预期的错误，提示用户创建表）
        if (isTableNotFound) {
          if (i === 0) {
            // 只提示一次
            console.warn(`[trader-followers] trader_follows 表不存在，请运行 scripts/setup_trader_follows.sql 创建表`)
          }
        } else {
          // 真正的错误，记录详细信息
          console.error(`[trader-followers] 批量获取粉丝数失败 (batch ${batchNum}):`, {
            error,
            message: error.message,
            code: error.code,
            hint: error.hint,
            details: error.details,
            batchNum,
          })
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


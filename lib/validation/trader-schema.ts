/**
 * Trader数据Schema验证
 * 使用Zod进行强类型验证，防止脏数据进入数据库
 * 
 * @see ~/ranking-arena/ARENA_DATA_INFRASTRUCTURE_UPGRADE.md#解决方案3-数据质量保障体系
 */

import { z } from 'zod'
import { dataLogger } from '../utils/logger'

/**
 * 支持的交易所列表
 */
export const SUPPORTED_SOURCES = [
  'binance_futures',
  'binance_spot', 
  'binance_web3',
  'bybit',
  'okx',
  'okx_wallet',
  'bitget_futures',
  'bitget_spot',
  'gateio',
  'mexc',
  'bingx',
  'htx',
  'kucoin',
  'coinex',
  'phemex',
  'bitmart',
  'weex',
  'blofin',
  'hyperliquid',
  'gmx',
  'dydx',
  // ... 其他交易所
] as const

export type SupportedSource = typeof SUPPORTED_SOURCES[number]

/**
 * 权益曲线数据点
 */
export const EquityCurvePointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)'),
  value: z.number().finite(),
  roi: z.number().finite().optional(),
  pnl: z.number().finite().optional(),
})

/**
 * 交易员快照核心Schema
 */
export const TraderSnapshotSchema = z.object({
  // 必需字段（严格验证）
  source: z.enum(SUPPORTED_SOURCES, {
    message: 'Invalid exchange source',
  }),
  source_trader_id: z.string().min(1, 'Trader ID cannot be empty'),
  roi: z.number().finite({ message: 'ROI must be a finite number' }),
  pnl: z.number().finite({ message: 'PnL must be a finite number' }),
  captured_at: z.coerce.date(),
  
  // 基础可选字段（带验证规则）
  win_rate: z.number()
    .min(0, 'Win rate cannot be negative')
    .max(100, 'Win rate cannot exceed 100%')
    .optional(),
  
  max_drawdown: z.number()
    .max(0, 'Max drawdown should be <= 0')
    .optional(),
  
  trades_count: z.number()
    .int('Trades count must be an integer')
    .nonnegative('Trades count cannot be negative')
    .optional(),
  
  followers: z.number()
    .int()
    .nonnegative()
    .optional(),
  
  aum: z.number()
    .nonnegative('AUM cannot be negative')
    .optional(),
  
  // 多时间段数据
  roi_7d: z.number().finite().optional(),
  roi_30d: z.number().finite().optional(),
  roi_90d: z.number().finite().optional(),
  
  pnl_7d: z.number().finite().optional(),
  pnl_30d: z.number().finite().optional(),
  pnl_90d: z.number().finite().optional(),
  
  win_rate_7d: z.number().min(0).max(100).optional(),
  win_rate_30d: z.number().min(0).max(100).optional(),
  win_rate_90d: z.number().min(0).max(100).optional(),
  
  max_drawdown_7d: z.number().max(0).optional(),
  max_drawdown_30d: z.number().max(0).optional(),
  max_drawdown_90d: z.number().max(0).optional(),
  
  // 高级指标
  sharpe_ratio: z.number().finite().optional(),
  sortino_ratio: z.number().finite().optional(),
  calmar_ratio: z.number().finite().optional(),
  profit_factor: z.number().finite().optional(),
  
  // JSON扩展字段（交易所特定数据）
  exchange_data: z.record(z.string(), z.unknown()).optional(),
  
  // 权益曲线
  equity_curve: z.array(EquityCurvePointSchema).optional(),
  
  // 元数据
  rank: z.number().int().positive().optional(),
  handle: z.string().optional(),
  avatar_url: z.string().url({ message: 'Invalid avatar URL' }).optional(),
})

export type TraderSnapshot = z.infer<typeof TraderSnapshotSchema>

/**
 * 验证并插入trader数据
 * 
 * @example
 * ```ts
 * const result = await validateAndInsertTrader({
 *   source: 'bybit',
 *   source_trader_id: 'ABC123',
 *   roi: 125.5,
 *   pnl: 45230.12,
 *   captured_at: new Date(),
 * })
 * ```
 */
export async function validateAndInsertTrader(data: unknown) {
  try {
    // 1. Schema验证
    const validated = TraderSnapshotSchema.parse(data)
    
    // 2. 业务逻辑验证（可选）
    if (validated.roi && validated.pnl && validated.aum) {
      const expectedROI = (validated.pnl / validated.aum) * 100
      const diff = Math.abs(expectedROI - validated.roi)
      if (diff > 50) {
        dataLogger.warn(`[VALIDATION WARNING] ROI/PnL/AUM mismatch: trader=${validated.source_trader_id}`)
      }
    }
    
    // 3. 插入数据库
    // const inserted = await db.trader_snapshots.insert(validated)
    // return inserted
    
    return validated
  } catch (error) {
    if (error instanceof z.ZodError) {
      dataLogger.error('[VALIDATION ERROR] Invalid trader data:', {
        source: (data as Record<string, unknown>)?.source,
        trader_id: (data as Record<string, unknown>)?.source_trader_id,
        errors: error.issues,
      })
    }
    throw error
  }
}

/**
 * 批量验证
 */
export async function validateTraderBatch(traders: unknown[]) {
  const results = {
    valid: [] as TraderSnapshot[],
    invalid: [] as { data: unknown; errors: z.ZodError }[],
  }
  
  for (const trader of traders) {
    try {
      const validated = TraderSnapshotSchema.parse(trader)
      results.valid.push(validated)
    } catch (error) {
      if (error instanceof z.ZodError) {
        results.invalid.push({ data: trader, errors: error })
      }
    }
  }
  
  return results
}

/**
 * 宽松验证（用于已有数据迁移）
 */
export const TraderSnapshotLooseSchema = TraderSnapshotSchema.partial({
  roi: true,
  pnl: true,
  // 允许核心字段为空（用于历史数据补全）
})

/**
 * 数据异常检测规则引擎
 * 
 * 自动检测数据质量问题，支持：
 * - 自动阻止（block）: 严重错误，拒绝入库
 * - 自动告警（alert）: 可疑数据，发送Telegram通知
 * - 自动修复（autoFix）: 简单错误自动纠正
 * 
 * @see ~/ranking-arena/ARENA_DATA_INFRASTRUCTURE_UPGRADE.md#解决方案2-数据质量保障体系
 */

import type { TraderSnapshot } from '../validation/trader-schema'
import { dataLogger } from '../utils/logger'

export interface AnomalyRule {
  id: string
  name: string
  description: string
  check: (trader: TraderSnapshot) => Promise<boolean> | boolean
  severity: 'critical' | 'warning' | 'info'
  action: 'block' | 'alert' | 'log'
  autoFix?: (trader: TraderSnapshot) => Promise<TraderSnapshot> | TraderSnapshot
}

/**
 * 核心异常检测规则库
 */
export const ANOMALY_RULES: AnomalyRule[] = [
  // ========== Critical Rules (Block) ==========
  
  {
    id: 'negative_trades_count',
    name: '交易次数为负',
    description: 'trades_count < 0',
    severity: 'critical',
    action: 'block',
    check: (t) => t.trades_count != null && t.trades_count < 0,
  },
  
  {
    // CONVENTION FLIP (2026-04-09): max_drawdown is stored as a POSITIVE
    // percentage in [0, 100] (e.g. 25 = "25% drawdown"). Originally this
    // rule blocked positive values and force-flipped them to negative,
    // but the writer convention changed. The on-disk data is now 100%
    // positive (verified: 37,829 rows, min=0, max=100, zero negatives)
    // and the score formula uses Math.abs() so it's sign-agnostic.
    // See migration 20260409180432.
    id: 'mdd_negative',
    name: '最大回撤为负数',
    description: 'max_drawdown < 0 (should be positive percentage 0-100)',
    severity: 'critical',
    action: 'block',
    check: (t) => t.max_drawdown != null && t.max_drawdown < 0,
    autoFix: (t) => ({
      ...t,
      max_drawdown: Math.abs(t.max_drawdown!),
    }),
  },
  
  {
    id: 'win_rate_out_of_range',
    name: '胜率超出范围',
    description: 'win_rate not in [0, 100]',
    severity: 'critical',
    action: 'block',
    check: (t) => t.win_rate != null && (t.win_rate < 0 || t.win_rate > 100),
    autoFix: (t) => ({
      ...t,
      win_rate: Math.max(0, Math.min(100, t.win_rate!)),
    }),
  },
  
  {
    id: 'roi_extreme_negative',
    name: 'ROI异常低',
    description: 'ROI < -100% (impossible to lose more than 100%)',
    severity: 'critical',
    action: 'block',
    check: (t) => t.roi < -100,
  },
  
  // ========== Warning Rules (Alert) ==========
  
  {
    id: 'roi_extreme_high',
    name: 'ROI异常高',
    description: 'ROI > 10000% (suspicious)',
    severity: 'warning',
    action: 'alert',
    check: (t) => t.roi > 10000,
  },
  
  {
    id: 'roi_pnl_aum_mismatch',
    name: 'ROI与PnL/AUM不一致',
    description: 'If AUM exists, ROI should ≈ PnL/AUM * 100',
    severity: 'warning',
    action: 'alert',
    check: (t) => {
      if (!t.aum || t.aum === 0) return false
      
      const expectedROI = (t.pnl / t.aum) * 100
      const diff = Math.abs(expectedROI - t.roi)
      
      // 允许50%的误差（因为可能是不同时间点的数据）
      return diff > 50
    },
  },
  
  {
    id: 'equity_curve_gaps',
    name: '权益曲线断档',
    description: 'Gaps > 7 days in equity curve',
    severity: 'warning',
    action: 'log',
    check: (t) => {
      if (!t.equity_curve || t.equity_curve.length < 2) return false
      
      const sorted = [...t.equity_curve].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      )
      
      for (let i = 1; i < sorted.length; i++) {
        const gap =
          (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) /
          (1000 * 86400) // days
        if (gap > 7) return true
      }
      
      return false
    },
  },
  
  {
    id: 'pnl_extreme',
    name: 'PnL异常值',
    description: 'Absolute PnL > $10M (suspicious for most traders)',
    severity: 'warning',
    action: 'alert',
    check: (t) => Math.abs(t.pnl) > 10_000_000,
  },
  
  {
    id: 'aum_too_low',
    name: 'AUM过低',
    description: 'AUM < $100 but has followers (suspicious)',
    severity: 'warning',
    action: 'log',
    check: (t) => t.aum != null && t.aum < 100 && (t.followers || 0) > 0,
  },
  
  {
    id: 'no_trades_but_high_roi',
    name: '无交易但高ROI',
    description: 'trades_count = 0 but ROI > 0',
    severity: 'warning',
    action: 'alert',
    check: (t) => t.trades_count === 0 && t.roi > 0,
  },
  
  // ========== Info Rules (Log only) ==========
  
  {
    id: 'missing_7d_30d_data',
    name: '缺少短期数据',
    description: 'Missing roi_7d or roi_30d',
    severity: 'info',
    action: 'log',
    check: (t) => t.roi_7d == null || t.roi_30d == null,
  },
  
  {
    id: 'missing_advanced_metrics',
    name: '缺少高级指标',
    description: 'Missing sharpe_ratio, sortino_ratio, etc.',
    severity: 'info',
    action: 'log',
    check: (t) =>
      t.sharpe_ratio == null &&
      t.sortino_ratio == null &&
      t.calmar_ratio == null &&
      t.profit_factor == null,
  },
]

/**
 * 异常检测引擎
 */
export class AnomalyDetector {
  constructor(private rules: AnomalyRule[] = ANOMALY_RULES) {}
  
  /**
   * 验证单个trader数据
   */
  async validate(trader: TraderSnapshot): Promise<{
    valid: boolean
    errors: string[]
    warnings: string[]
    info: string[]
    fixed?: TraderSnapshot
  }> {
    const errors: string[] = []
    const warnings: string[] = []
    const info: string[] = []
    let fixed = trader
    
    for (const rule of this.rules) {
      const isAnomaly = await rule.check(trader)
      
      if (isAnomaly) {
        const message = `[${rule.id}] ${rule.name}: ${rule.description}`
        
        switch (rule.action) {
          case 'block':
            errors.push(message)
            // 尝试自动修复
            if (rule.autoFix) {
              fixed = await rule.autoFix(fixed)
              dataLogger.info(`[AUTO-FIX] ${rule.id}`)
            }
            break
            
          case 'alert':
            warnings.push(message)
            // 告警由外部系统处理
            break
            
          case 'log':
            info.push(message)
            dataLogger.debug(`[INFO] ${message}`)
            break
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      info,
      fixed: errors.length > 0 && fixed !== trader ? fixed : undefined,
    }
  }
  
  /**
   * 批量验证
   */
  async validateBatch(traders: TraderSnapshot[]): Promise<{
    valid: TraderSnapshot[]
    blocked: Array<{ trader: TraderSnapshot; errors: string[] }>
    warnings: Array<{ trader: TraderSnapshot; warnings: string[] }>
  }> {
    const valid: TraderSnapshot[] = []
    const blocked: Array<{ trader: TraderSnapshot; errors: string[] }> = []
    const warnings: Array<{ trader: TraderSnapshot; warnings: string[] }> = []
    
    for (const trader of traders) {
      const result = await this.validate(trader)
      
      if (!result.valid) {
        blocked.push({ trader, errors: result.errors })
      } else {
        valid.push(result.fixed || trader)
        
        if (result.warnings.length > 0) {
          warnings.push({ trader, warnings: result.warnings })
        }
      }
    }
    
    return { valid, blocked, warnings }
  }
}

/**
 * 使用示例
 * 
 * @example
 * ```ts
 * import { AnomalyDetector } from '@/lib/monitoring/anomaly-rules'
 * import { sendTelegramAlert } from '@/lib/notifications'
 * 
 * const detector = new AnomalyDetector()
 * 
 * const result = await detector.validate(traderData)
 * 
 * if (!result.valid) {
 *   console.error('Validation failed:', result.errors)
 *   if (result.fixed) {
 *     console.log('Auto-fixed version:', result.fixed)
 *     // 使用修复后的数据
 *   } else {
 *     throw new Error('Cannot auto-fix, blocking insert')
 *   }
 * }
 * 
 * if (result.warnings.length > 0) {
 *   await sendTelegramAlert(`⚠️ Data quality warning\n${result.warnings.join('\n')}`)
 * }
 * ```
 */

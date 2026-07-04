/**
 * 哨兵共享的 trader_stats typed 指标列清单(P4:单一来源,替代各脚本硬编码)。
 *
 * 与 lib/ingest/core/types.ts 的 ExpectedMetric 联合类型一一对应
 * (13 列;新增指标列时两处同改 — 需要迁移+多处代码,不会静默漂移)。
 * 消费方:fill-rate-check.mjs(填充率契约)、render-coverage-check.mjs
 * (DB→API 渲染契约)。
 */

export const TYPED_METRICS = [
  'roi',
  'pnl',
  'sharpe',
  'mdd',
  'win_rate',
  'win_positions',
  'total_positions',
  'copier_pnl',
  'copier_count',
  'aum',
  'volume',
  'profit_share_rate',
  'holding_duration_avg',
]

/** 回填趋势哨兵盯梢的 profile-refill 指标(series-backfill 渐进补全的那批)。 */
export const TREND_METRICS = ['mdd', 'win_positions', 'copier_pnl', 'sharpe', 'copier_count']

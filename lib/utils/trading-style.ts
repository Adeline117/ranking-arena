/**
 * 交易风格自动分类工具
 * 根据持仓时间和交易频率自动判断交易风格
 */

export type TradingStyle = 'scalper' | 'swing' | 'trend' | 'position' | 'unknown'

export interface TradingStyleInfo {
  style: TradingStyle
  label: string
  labelEn: string
  color: string
  bgColor: string
  borderColor: string
}

const STYLE_MAP: Record<TradingStyle, Omit<TradingStyleInfo, 'style'>> = {
  scalper: {
    label: '高频',
    labelEn: 'Scalper',
    color: 'var(--color-accent-error)',
    bgColor: 'var(--color-accent-error-12)',
    borderColor: 'var(--color-accent-error-20)',
  },
  swing: {
    label: '波段',
    labelEn: 'Swing',
    color: 'var(--color-score-profitability)',
    bgColor: 'var(--color-accent-primary-12)',
    borderColor: 'var(--color-accent-primary-30)',
  },
  trend: {
    label: '趋势',
    labelEn: 'Trend',
    color: 'var(--color-score-great)',
    bgColor: 'var(--color-accent-success-12)',
    borderColor: 'var(--color-accent-success-20)',
  },
  position: {
    label: '长线',
    labelEn: 'Position',
    color: 'var(--color-score-legendary)',
    bgColor: 'var(--color-accent-primary-12)',
    borderColor: 'var(--color-accent-primary-30)',
  },
  unknown: {
    label: '未知',
    labelEn: 'Unknown',
    color: 'var(--color-score-low)',
    bgColor: 'var(--color-overlay-subtle)',
    borderColor: 'var(--color-overlay-medium)',
  },
}

export interface ClassifyMetrics {
  avg_holding_hours?: number | null
  trades_count?: number | null
  win_rate?: number | null
  profit_factor?: number | null
}

/**
 * 根据交易指标自动判断交易风格
 */
export function classifyStyle(metrics: ClassifyMetrics): TradingStyle {
  const { avg_holding_hours, trades_count, win_rate, profit_factor } = metrics

  if (avg_holding_hours != null && avg_holding_hours > 0) {
    if (avg_holding_hours < 4 && (trades_count ?? 0) > 50) return 'scalper'
    if (avg_holding_hours < 48) return 'swing'
    if (avg_holding_hours < 336) return 'trend'
    return 'position'
  }

  // 无持仓时间数据时的推断逻辑
  if ((win_rate ?? 0) > 60 && (profit_factor ?? 2) < 1.5) return 'scalper'

  return 'unknown'
}

/**
 * 获取交易风格的完整信息
 */
export function getStyleInfo(style: TradingStyle): TradingStyleInfo {
  return { style, ...STYLE_MAP[style] }
}

/**
 * 获取所有可筛选的交易风格（不含unknown）
 */
export function getFilterableStyles(): TradingStyleInfo[] {
  return (['scalper', 'swing', 'trend', 'position'] as TradingStyle[]).map(s => getStyleInfo(s))
}

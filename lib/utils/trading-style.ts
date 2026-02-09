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
    color: '#f43f5e',
    bgColor: 'rgba(244,63,94,0.12)',
    borderColor: 'rgba(244,63,94,0.35)',
  },
  swing: {
    label: '波段',
    labelEn: 'Swing',
    color: '#3b82f6',
    bgColor: 'rgba(59,130,246,0.12)',
    borderColor: 'rgba(59,130,246,0.35)',
  },
  trend: {
    label: '趋势',
    labelEn: 'Trend',
    color: '#10b981',
    bgColor: 'rgba(16,185,129,0.12)',
    borderColor: 'rgba(16,185,129,0.35)',
  },
  position: {
    label: '长线',
    labelEn: 'Position',
    color: '#8b5cf6',
    bgColor: 'rgba(139,92,246,0.12)',
    borderColor: 'rgba(139,92,246,0.35)',
  },
  unknown: {
    label: '未知',
    labelEn: 'Unknown',
    color: '#6b7280',
    bgColor: 'rgba(107,114,128,0.12)',
    borderColor: 'rgba(107,114,128,0.35)',
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

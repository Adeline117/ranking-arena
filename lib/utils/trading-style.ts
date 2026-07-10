/**
 * 交易风格自动分类工具
 * 根据持仓时间和交易频率自动判断交易风格
 */

/**
 * Trading style classification (canonical definition)
 *
 * - scalper: High-frequency, short holding periods (<4h), many trades
 * - swing: Medium-term trades, holding 4-48 hours
 * - trend: Longer-term trend following, holding 48h-2 weeks
 * - position: Long-term holding, >2 weeks
 * - unknown: Unable to classify (insufficient data)
 */
// v4 分类器扩展词汇(2026-07-10 UI 走查):day_trader/conservative/balanced/
// aggressive 是 leaderboard_ranks.trading_style 的真实值(合计 ~8,000 行),
// 旧 5 款词汇让它们落进 STYLE_MAP 空洞 → 无色 chip + 原始 i18n key 直出。
export type TradingStyle =
  | 'scalper'
  | 'day_trader'
  | 'swing'
  | 'trend'
  | 'position'
  | 'conservative'
  | 'balanced'
  | 'aggressive'
  | 'unknown'

export const VALID_TRADING_STYLES = ['scalper', 'swing', 'trend', 'position'] as const
export type FilterableTradingStyle = (typeof VALID_TRADING_STYLES)[number]

export type TradingStyleLegacy = 'high_frequency' | 'swing' | 'trend' | 'scalping' | 'position'

export const TRADING_STYLE_LEGACY_MAP: Record<
  TradingStyleLegacy | 'hft' | 'day_trader',
  TradingStyle
> = {
  high_frequency: 'scalper',
  hft: 'scalper',
  scalping: 'scalper',
  // day_trader 曾被压扁成 swing;v4 起是独立风格,不再折叠。
  day_trader: 'day_trader',
  swing: 'swing',
  trend: 'trend',
  position: 'position',
}

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
  day_trader: {
    label: '日内',
    labelEn: 'Day Trader',
    color: 'var(--color-accent-warning)',
    bgColor: 'var(--color-accent-warning-12)',
    borderColor: 'var(--color-accent-warning-20)',
  },
  conservative: {
    label: '稳健',
    labelEn: 'Conservative',
    color: 'var(--color-accent-success)',
    bgColor: 'var(--color-accent-success-12)',
    borderColor: 'var(--color-accent-success-20)',
  },
  balanced: {
    label: '均衡',
    labelEn: 'Balanced',
    color: 'var(--color-text-secondary)',
    bgColor: 'var(--color-overlay-subtle)',
    borderColor: 'var(--color-overlay-medium)',
  },
  aggressive: {
    label: '激进',
    labelEn: 'Aggressive',
    color: 'var(--color-accent-error)',
    bgColor: 'var(--color-accent-error-12)',
    borderColor: 'var(--color-accent-error-20)',
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
export function getStyleInfo(style: TradingStyle | string): TradingStyleInfo {
  // 归一 legacy 别名(hft/high_frequency/scalping);词汇表外的值防御性落
  // unknown —— 绝不再产出无色 chip/裸 key(2026-07-10 走查教训)。
  const normalized =
    (TRADING_STYLE_LEGACY_MAP as Record<string, TradingStyle>)[style] ??
    (style in STYLE_MAP ? (style as TradingStyle) : 'unknown')
  return { style: normalized, ...STYLE_MAP[normalized] }
}

/**
 * 获取所有可筛选的交易风格（不含unknown）
 */
export function getFilterableStyles(): TradingStyleInfo[] {
  return (['scalper', 'swing', 'trend', 'position'] as TradingStyle[]).map((s) => getStyleInfo(s))
}

/**
 * 告警配置预设模板
 * 帮助用户快速配置告警阈值
 */

export interface AlertPreset {
  id: string
  name: string
  description: string
  icon: string
  /** 回撤告警阈值 (%) */
  drawdown_threshold: number
  /** 胜率下降告警阈值 (%) */
  win_rate_drop_threshold: number
  /** 跟单者撤离告警阈值 (%) */
  follower_exodus_threshold: number
  /** 仓位异常放大阈值 (倍) */
  position_spike_threshold: number
  /** 建议的用户类型 */
  recommended_for: string[]
  /** 风险等级 */
  risk_level: 'low' | 'medium' | 'high'
}

/**
 * 预设告警配置模板
 */
export const ALERT_PRESETS: Record<string, AlertPreset> = {
  conservative: {
    id: 'conservative',
    name: '保守型',
    description: '回撤超过 8% 即告警，适合追求稳定的用户',
    icon: '🛡️',
    drawdown_threshold: 8,
    win_rate_drop_threshold: 5,
    follower_exodus_threshold: 10,
    position_spike_threshold: 2,
    recommended_for: ['新手', '稳健投资者', '小资金用户'],
    risk_level: 'low',
  },
  balanced: {
    id: 'balanced',
    name: '适中型',
    description: '平衡收益与风险，适合大多数跟单者',
    icon: '⚖️',
    drawdown_threshold: 15,
    win_rate_drop_threshold: 10,
    follower_exodus_threshold: 20,
    position_spike_threshold: 3,
    recommended_for: ['有经验的跟单者', '中等资金用户'],
    risk_level: 'medium',
  },
  aggressive: {
    id: 'aggressive',
    name: '激进型',
    description: '容忍较大波动，减少告警打扰',
    icon: '🔥',
    drawdown_threshold: 25,
    win_rate_drop_threshold: 15,
    follower_exodus_threshold: 30,
    position_spike_threshold: 5,
    recommended_for: ['高风险承受能力', '大资金用户', '长期投资者'],
    risk_level: 'high',
  },
  custom: {
    id: 'custom',
    name: '自定义',
    description: '根据自己的需求设置阈值',
    icon: '⚙️',
    drawdown_threshold: 15,
    win_rate_drop_threshold: 10,
    follower_exodus_threshold: 20,
    position_spike_threshold: 3,
    recommended_for: ['专业用户'],
    risk_level: 'medium',
  },
}

/**
 * 获取预设列表（用于 UI 展示）
 */
export function getAlertPresetList(): AlertPreset[] {
  return Object.values(ALERT_PRESETS)
}

/**
 * 根据用户输入判断最匹配的预设
 */
export function detectPresetFromConfig(config: {
  drawdown_threshold?: number
  win_rate_drop_threshold?: number
}): string {
  const { drawdown_threshold = 15 } = config
  
  if (drawdown_threshold <= 10) {
    return 'conservative'
  } else if (drawdown_threshold <= 20) {
    return 'balanced'
  } else {
    return 'aggressive'
  }
}

/**
 * 根据交易员历史表现推荐预设
 */
export function recommendPresetForTrader(traderStats: {
  avg_drawdown?: number
  volatility?: 'low' | 'medium' | 'high'
  roi?: number
}): AlertPreset {
  const { avg_drawdown = 10, volatility = 'medium' } = traderStats
  
  // 高波动交易员，推荐激进型（避免频繁告警）
  if (avg_drawdown > 20 || volatility === 'high') {
    return ALERT_PRESETS.aggressive
  }
  
  // 低波动交易员，推荐保守型（更早预警）
  if (avg_drawdown < 8) {
    return ALERT_PRESETS.conservative
  }
  
  // 默认推荐适中型
  return ALERT_PRESETS.balanced
}

/**
 * 告警级别描述
 */
export const ALERT_SEVERITY_INFO = {
  LOW: {
    label: '低',
    color: '#4CAF50',
    description: '仅供参考，无需立即行动',
  },
  MEDIUM: {
    label: '中',
    color: '#FF9800',
    description: '建议关注，可能需要调整',
  },
  HIGH: {
    label: '高',
    color: '#F44336',
    description: '需要注意，建议检查仓位',
  },
  CRITICAL: {
    label: '紧急',
    color: '#D32F2F',
    description: '需要立即行动',
  },
}

/**
 * 告警类型描述
 */
export const ALERT_TYPE_INFO = {
  DRAWDOWN_WARNING: {
    label: '回撤预警',
    icon: '📉',
    description: '交易员回撤超过设定阈值',
  },
  DRAWDOWN_SPIKE: {
    label: '回撤急剧加深',
    icon: '⚠️',
    description: '回撤在短时间内大幅增加',
  },
  STYLE_CHANGE: {
    label: '风格突变',
    icon: '🔄',
    description: '交易员交易风格发生明显变化',
  },
  POSITION_SPIKE: {
    label: '仓位异常',
    icon: '📊',
    description: '交易员仓位异常放大',
  },
  WIN_RATE_DROP: {
    label: '胜率下降',
    icon: '📉',
    description: '交易员胜率明显下降',
  },
  FOLLOWER_EXODUS: {
    label: '跟单者撤离',
    icon: '🏃',
    description: '大量跟单者在短时间内撤离',
  },
  PROFIT_TARGET_HIT: {
    label: '达到止盈',
    icon: '🎯',
    description: '收益达到设定的止盈目标',
  },
  STOP_LOSS_HIT: {
    label: '触发止损',
    icon: '🛑',
    description: '亏损达到设定的止损线',
  },
}

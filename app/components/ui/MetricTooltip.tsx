'use client'

/**
 * MetricTooltip - 指标公式解释组件
 * 
 * 为每个指标提供问号 (?) 图标，hover 显示公式逻辑
 * 增加专业用户信任感
 */

import React, { useState, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'

export type MetricType = 
  | 'roi' 
  | 'pnl' 
  | 'winRate' 
  | 'maxDrawdown' 
  | 'arenaScore'
  | 'sharpeRatio'
  | 'sortinoRatio'
  | 'calmarRatio'
  | 'profitFactor'
  | 'avgWin'
  | 'avgLoss'
  | 'tradesCount'
  | 'followers'

interface MetricExplanation {
  title: string
  titleZh: string
  formula: string
  description: string
  descriptionZh: string
}

const METRIC_EXPLANATIONS: Record<MetricType, MetricExplanation> = {
  roi: {
    title: 'Return on Investment',
    titleZh: '投资回报率',
    formula: 'ROI = (Final Value - Initial Value) / Initial Value × 100%',
    description: 'Percentage gain or loss relative to initial capital',
    descriptionZh: '相对于初始资本的收益或损失百分比',
  },
  pnl: {
    title: 'Profit and Loss',
    titleZh: '盈亏',
    formula: 'PnL = Σ(Realized Profits) + Unrealized PnL',
    description: 'Total absolute profit or loss in USD',
    descriptionZh: '以美元计的总绝对盈亏',
  },
  winRate: {
    title: 'Win Rate',
    titleZh: '胜率',
    formula: 'Win Rate = Winning Trades / Total Trades × 100%',
    description: 'Percentage of trades that were profitable',
    descriptionZh: '盈利交易占总交易的百分比',
  },
  maxDrawdown: {
    title: 'Maximum Drawdown',
    titleZh: '最大回撤',
    formula: 'MDD = (Peak Value - Trough Value) / Peak Value × 100%',
    description: 'Largest peak-to-trough decline in portfolio value',
    descriptionZh: '投资组合价值从峰值到谷底的最大跌幅',
  },
  arenaScore: {
    title: 'Arena Score',
    titleZh: 'Arena 评分',
    formula: 'Score = w₁×Return + w₂×Risk + w₃×Consistency + w₄×Volume',
    description: 'Weighted composite score (0-100) measuring overall trading performance',
    descriptionZh: '综合衡量交易表现的加权评分 (0-100)',
  },
  sharpeRatio: {
    title: 'Sharpe Ratio',
    titleZh: '夏普比率',
    formula: 'Sharpe = (Rp - Rf) / σp',
    description: 'Risk-adjusted return: excess return per unit of volatility',
    descriptionZh: '风险调整收益：每单位波动率的超额收益',
  },
  sortinoRatio: {
    title: 'Sortino Ratio',
    titleZh: '索提诺比率',
    formula: 'Sortino = (Rp - Rf) / σd',
    description: 'Like Sharpe but only penalizes downside volatility',
    descriptionZh: '类似夏普但只考虑下行波动',
  },
  calmarRatio: {
    title: 'Calmar Ratio',
    titleZh: '卡尔玛比率',
    formula: 'Calmar = Annual Return / Max Drawdown',
    description: 'Annual return relative to maximum drawdown risk',
    descriptionZh: '年化收益相对于最大回撤风险',
  },
  profitFactor: {
    title: 'Profit Factor',
    titleZh: '盈利因子',
    formula: 'PF = Gross Profit / Gross Loss',
    description: 'Ratio of total gains to total losses (>1 is profitable)',
    descriptionZh: '总盈利与总亏损的比率 (>1 表示盈利)',
  },
  avgWin: {
    title: 'Average Win',
    titleZh: '平均盈利',
    formula: 'Avg Win = Σ(Winning Trade PnL) / # Winning Trades',
    description: 'Average profit per winning trade',
    descriptionZh: '每笔盈利交易的平均收益',
  },
  avgLoss: {
    title: 'Average Loss',
    titleZh: '平均亏损',
    formula: 'Avg Loss = Σ(Losing Trade PnL) / # Losing Trades',
    description: 'Average loss per losing trade',
    descriptionZh: '每笔亏损交易的平均损失',
  },
  tradesCount: {
    title: 'Trades Count',
    titleZh: '交易次数',
    formula: 'Count = # Closed Positions',
    description: 'Total number of completed trades in the period',
    descriptionZh: '该时期内完成的交易总数',
  },
  followers: {
    title: 'Followers',
    titleZh: '跟单人数',
    formula: 'Followers = Active Copy Traders',
    description: 'Number of users actively copying this trader',
    descriptionZh: '正在跟单该交易员的用户数量',
  },
}

interface MetricTooltipProps {
  metric: MetricType
  size?: 'sm' | 'md'
  language?: 'en' | 'zh'
  className?: string
}

export function MetricTooltip({ 
  metric, 
  size = 'sm',
  language = 'en',
  className = '',
}: MetricTooltipProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [position, setPosition] = useState<'top' | 'bottom'>('top')
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  
  const explanation = METRIC_EXPLANATIONS[metric]
  const isZh = language === 'zh'
  
  // Adjust tooltip position based on available space
  useEffect(() => {
    if (isVisible && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const spaceAbove = rect.top
      const _spaceBelow = window.innerHeight - rect.bottom
      setPosition(spaceAbove > 200 ? 'top' : 'bottom')
    }
  }, [isVisible])
  
  const iconSize = size === 'sm' ? 12 : 14
  
  return (
    <span 
      ref={triggerRef}
      className={`inline-flex items-center cursor-help ${className}`}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onTouchStart={() => setIsVisible(!isVisible)}
    >
      <svg 
        width={iconSize} 
        height={iconSize} 
        viewBox="0 0 16 16" 
        fill="none"
        style={{ opacity: 0.5 }}
      >
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <text 
          x="8" 
          y="11.5" 
          textAnchor="middle" 
          fontSize="9" 
          fontWeight="600"
          fill="currentColor"
        >
          ?
        </text>
      </svg>
      
      {isVisible && (
        <div
          ref={tooltipRef}
          className="absolute z-50 w-64 p-3 rounded-lg shadow-xl"
          style={{
            backgroundColor: tokens.colors.bg.primary,
            border: `1px solid ${tokens.colors.border.primary}`,
            [position === 'top' ? 'bottom' : 'top']: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: position === 'top' ? 8 : 0,
            marginTop: position === 'bottom' ? 8 : 0,
          }}
        >
          {/* Title */}
          <div 
            className="text-sm font-semibold mb-1"
            style={{ color: tokens.colors.text.primary }}
          >
            {isZh ? explanation.titleZh : explanation.title}
          </div>
          
          {/* Formula */}
          <div 
            className="text-xs font-mono px-2 py-1 rounded mb-2"
            style={{ 
              backgroundColor: tokens.colors.bg.tertiary,
              color: tokens.colors.accent.brand,
            }}
          >
            {explanation.formula}
          </div>
          
          {/* Description */}
          <div 
            className="text-xs"
            style={{ color: tokens.colors.text.secondary }}
          >
            {isZh ? explanation.descriptionZh : explanation.description}
          </div>
          
          {/* Arrow */}
          <div
            className="absolute w-2 h-2 rotate-45"
            style={{
              backgroundColor: tokens.colors.bg.primary,
              borderRight: position === 'top' ? `1px solid ${tokens.colors.border.primary}` : 'none',
              borderBottom: position === 'top' ? `1px solid ${tokens.colors.border.primary}` : 'none',
              borderLeft: position === 'bottom' ? `1px solid ${tokens.colors.border.primary}` : 'none',
              borderTop: position === 'bottom' ? `1px solid ${tokens.colors.border.primary}` : 'none',
              [position === 'top' ? 'bottom' : 'top']: -5,
              left: '50%',
              transform: 'translateX(-50%)',
            }}
          />
        </div>
      )}
    </span>
  )
}

/**
 * Wrapper component for metrics with labels
 */
interface MetricWithTooltipProps {
  label: string
  value: string | number
  metric: MetricType
  language?: 'en' | 'zh'
  valueColor?: string
  className?: string
}

export function MetricWithTooltip({
  label,
  value,
  metric,
  language = 'en',
  valueColor,
  className = '',
}: MetricWithTooltipProps) {
  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex items-center gap-1">
        <span 
          className="text-xs"
          style={{ color: tokens.colors.text.secondary }}
        >
          {label}
        </span>
        <MetricTooltip metric={metric} language={language} />
      </div>
      <span 
        className="text-sm font-semibold"
        style={{ color: valueColor || tokens.colors.text.primary }}
      >
        {value}
      </span>
    </div>
  )
}

export default MetricTooltip

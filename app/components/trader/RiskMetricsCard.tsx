'use client'

import { useMemo, useState } from 'react'
import { Box, Text } from '../base'
import Card from '../ui/Card'
import { useLanguage } from '../Providers/LanguageProvider'
import { formatRiskMetric, calculateRiskLevel, type RiskMetrics } from '@/lib/services/trading-metrics'

interface RiskMetricsCardProps {
  metrics: Partial<RiskMetrics> | null
  loading?: boolean
}

// 风险等级颜色
const RISK_LEVEL_COLORS = {
  1: '#2fe57d', // 低风险 - 绿色
  2: '#7dd87f', // 较低风险 - 浅绿
  3: '#ffc107', // 中等风险 - 黄色
  4: '#ff9800', // 较高风险 - 橙色
  5: '#ff5252', // 高风险 - 红色
}

// 风险等级描述
const RISK_LEVEL_LABELS: Record<number, string> = {
  1: '低风险',
  2: '较低风险',
  3: '中等风险',
  4: '较高风险',
  5: '高风险',
}

/**
 * 风险指标卡片组件
 */
export function RiskMetricsCard({ metrics, loading }: RiskMetricsCardProps) {
  const { t } = useLanguage()

  // 计算风险等级（如果未提供）
  const riskInfo = useMemo(() => {
    if (metrics?.riskLevel && metrics?.riskLevelDescription) {
      return { level: metrics.riskLevel, description: metrics.riskLevelDescription }
    }
    return calculateRiskLevel(
      metrics?.volatility ?? null,
      metrics?.maxDrawdown ?? null,
      metrics?.sharpeRatio ?? null
    )
  }, [metrics])

  if (loading) {
    return (
      <Card>
        <div className="p-4 space-y-4">
          <div className="h-6 bg-[var(--color-bg-tertiary)] rounded animate-pulse w-32" />
          <div className="grid grid-cols-2 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-16 bg-[var(--color-bg-tertiary)] rounded animate-pulse" />
            ))}
          </div>
        </div>
      </Card>
    )
  }

  if (!metrics) {
    return (
      <Card>
        <div className="p-4 text-center">
          <Text size="sm" color="tertiary">暂无风险指标数据</Text>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="p-4 space-y-4">
        {/* 标题和风险等级 */}
        <div className="flex items-center justify-between">
          <Text size="md" weight="bold">风险分析</Text>
          <RiskLevelBadge level={riskInfo.level} description={riskInfo.description} />
        </div>

        {/* 主要指标网格 */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricItem
            label="夏普率"
            value={formatRiskMetric(metrics.sharpeRatio ?? null, 'ratio')}
            description="风险调整收益"
            positive={metrics.sharpeRatio != null && metrics.sharpeRatio > 1}
          />
          <MetricItem
            label="索提诺比率"
            value={formatRiskMetric(metrics.sortinoRatio ?? null, 'ratio')}
            description="下行风险调整收益"
            positive={metrics.sortinoRatio != null && metrics.sortinoRatio > 1}
          />
          <MetricItem
            label="卡尔马比率"
            value={formatRiskMetric(metrics.calmarRatio ?? null, 'ratio')}
            description="收益/最大回撤"
            positive={metrics.calmarRatio != null && metrics.calmarRatio > 1}
          />
          <MetricItem
            label="年化波动率"
            value={formatRiskMetric(metrics.volatility ?? null, 'percentage')}
            description="价格变动幅度"
            negative={metrics.volatility != null && metrics.volatility > 50}
          />
          <MetricItem
            label="最大回撤"
            value={formatRiskMetric(metrics.maxDrawdown ?? null, 'percentage')}
            description="最大损失幅度"
            negative={metrics.maxDrawdown != null && Math.abs(metrics.maxDrawdown) > 30}
          />
          <MetricItem
            label="盈亏比"
            value={formatRiskMetric(metrics.profitLossRatio ?? null, 'ratio')}
            description="平均盈利/平均亏损"
            positive={metrics.profitLossRatio != null && metrics.profitLossRatio > 1.5}
          />
        </div>

        {/* 额外统计 */}
        {(metrics.maxConsecutiveLosses != null || metrics.maxConsecutiveWins != null) && (
          <div className="pt-3 border-t border-[var(--color-border-primary)]">
            <div className="flex items-center gap-4 text-xs">
              {metrics.maxConsecutiveWins != null && (
                <div className="flex items-center gap-1">
                  <span className="text-[var(--color-text-tertiary)]">最大连续盈利:</span>
                  <span className="text-[var(--color-success)] font-semibold">
                    {metrics.maxConsecutiveWins} 次
                  </span>
                </div>
              )}
              {metrics.maxConsecutiveLosses != null && (
                <div className="flex items-center gap-1">
                  <span className="text-[var(--color-text-tertiary)]">最大连续亏损:</span>
                  <span className="text-[var(--color-error)] font-semibold">
                    {metrics.maxConsecutiveLosses} 次
                  </span>
                </div>
              )}
              {metrics.maxDrawdownDuration != null && (
                <div className="flex items-center gap-1">
                  <span className="text-[var(--color-text-tertiary)]">回撤持续:</span>
                  <span className="text-[var(--color-text-secondary)] font-semibold">
                    {metrics.maxDrawdownDuration} 天
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 指标说明 */}
        <MetricsExplanation />
      </div>
    </Card>
  )
}

// ============================================
// 子组件
// ============================================

/**
 * 风险等级徽章
 */
function RiskLevelBadge({ level, description }: { level: number; description: string }) {
  const color = RISK_LEVEL_COLORS[level as keyof typeof RISK_LEVEL_COLORS] || RISK_LEVEL_COLORS[3]
  
  return (
    <div 
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
      style={{ 
        backgroundColor: `${color}20`,
        color: color,
        border: `1px solid ${color}40`
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <span>{description}</span>
      {/* 风险等级指示器 */}
      <div className="flex items-center gap-0.5 ml-1">
        {[1, 2, 3, 4, 5].map(i => (
          <div
            key={i}
            className="w-1.5 h-1.5 rounded-full"
            style={{
              backgroundColor: i <= level ? color : `${color}30`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * 单个指标项
 */
function MetricItem({ 
  label, 
  value, 
  description, 
  positive, 
  negative 
}: { 
  label: string
  value: string
  description: string
  positive?: boolean
  negative?: boolean
}) {
  const valueColor = positive 
    ? 'text-[var(--color-success)]' 
    : negative 
      ? 'text-[var(--color-error)]' 
      : 'text-[var(--color-text-primary)]'

  return (
    <div className="p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
      <div className="text-[10px] text-[var(--color-text-tertiary)] mb-0.5">{label}</div>
      <div className={`text-lg font-bold ${valueColor}`}>{value}</div>
      <div className="text-[9px] text-[var(--color-text-tertiary)] mt-0.5">{description}</div>
    </div>
  )
}

/**
 * 指标说明折叠区域
 */
function MetricsExplanation() {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="pt-2 border-t border-[var(--color-border-primary)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
      >
        <svg 
          width="12" 
          height="12" 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
        >
          <path d="M19 9l-7 7-7-7" />
        </svg>
        <span>指标说明</span>
      </button>
      
      {expanded && (
        <div className="mt-2 p-3 bg-[var(--color-bg-primary)] rounded-lg text-xs text-[var(--color-text-tertiary)] space-y-2">
          <p>
            <strong className="text-[var(--color-text-secondary)]">夏普率 (Sharpe Ratio):</strong>{' '}
            衡量风险调整后的收益。值越高表示每承担一单位风险获得的超额收益越多。一般认为 &gt;1 为好，&gt;2 为优秀。
          </p>
          <p>
            <strong className="text-[var(--color-text-secondary)]">索提诺比率 (Sortino Ratio):</strong>{' '}
            与夏普率类似，但只考虑下行波动（亏损），更适合评估不对称风险策略。
          </p>
          <p>
            <strong className="text-[var(--color-text-secondary)]">卡尔马比率 (Calmar Ratio):</strong>{' '}
            年化收益率与最大回撤的比值。值越高表示在承受同样回撤时获得的收益越多。
          </p>
          <p>
            <strong className="text-[var(--color-text-secondary)]">年化波动率:</strong>{' '}
            价格变动的标准差，衡量收益的不确定性。波动率越高风险越大。
          </p>
          <p>
            <strong className="text-[var(--color-text-secondary)]">盈亏比:</strong>{' '}
            平均盈利交易金额与平均亏损交易金额的比值。&gt;1.5 表示盈利能力较强。
          </p>
        </div>
      )}
    </div>
  )
}

export default RiskMetricsCard

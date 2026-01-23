'use client'

import { ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { DataAvailability, Exchange } from '@/lib/types/data-provenance'
import { getExchangeCapabilities } from '@/lib/types/data-provenance'

// Info icon SVG
const InfoIcon = ({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" strokeLinecap="round" />
    <circle cx="12" cy="8" r="0.5" fill={color} stroke="none" />
  </svg>
)

// Lock icon for unavailable features
const LockIcon = ({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0110 0v4" />
  </svg>
)

// Warning icon
const WarningIcon = ({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  </svg>
)

interface MissingDataPlaceholderProps {
  /** 数据状态 */
  availability: DataAvailability
  /** 数据来源交易所 */
  exchange?: Exchange | string
  /** 指标名称 */
  metricName?: string
  /** 不可用原因 */
  reason?: {
    zh: string
    en: string
  }
  /** 显示模式 */
  variant?: 'inline' | 'card' | 'minimal'
  /** 是否显示解释 */
  showExplanation?: boolean
  /** 自定义内容 */
  children?: ReactNode
  /** 自定义样式 */
  style?: React.CSSProperties
}

/**
 * 数据缺失占位符组件
 * 当某个交易所不提供特定数据时，优雅地展示"暂不支持"而不是空白或报错
 */
export default function MissingDataPlaceholder({
  availability,
  exchange,
  metricName,
  reason,
  variant = 'inline',
  showExplanation = true,
  children,
  style,
}: MissingDataPlaceholderProps) {
  const { language } = useLanguage()

  // 获取默认原因
  const getDefaultReason = () => {
    if (reason) return reason[language]

    switch (availability) {
      case 'unavailable':
        if (exchange) {
          const capabilities = getExchangeCapabilities(exchange as Exchange)
          if (capabilities?.notes) {
            return capabilities.notes[language]
          }
          return language === 'zh'
            ? `${exchange.toString().toUpperCase()} 暂不提供此数据`
            : `${exchange.toString().toUpperCase()} does not provide this data`
        }
        return language === 'zh' ? '该交易所未提供此数据' : 'This exchange does not provide this data'
      case 'delayed':
        return language === 'zh' ? '数据延迟中' : 'Data delayed'
      case 'partial':
        return language === 'zh' ? '仅部分数据可用' : 'Partial data available'
      case 'stale':
        return language === 'zh' ? '数据已过期' : 'Data is stale'
      case 'calculating':
        return language === 'zh' ? '正在计算中' : 'Calculating'
      default:
        return language === 'zh' ? '数据不可用' : 'Data unavailable'
    }
  }

  // 获取状态配置
  const getStatusConfig = () => {
    switch (availability) {
      case 'unavailable':
        return {
          icon: <LockIcon size={variant === 'minimal' ? 10 : 14} color={tokens.colors.text.tertiary} />,
          color: tokens.colors.text.tertiary,
          bgColor: `${tokens.colors.text.tertiary}08`,
          borderColor: `${tokens.colors.text.tertiary}15`,
          label: '—',
        }
      case 'delayed':
        return {
          icon: <WarningIcon size={variant === 'minimal' ? 10 : 14} color={tokens.colors.accent.warning} />,
          color: tokens.colors.accent.warning,
          bgColor: `${tokens.colors.accent.warning}10`,
          borderColor: `${tokens.colors.accent.warning}25`,
          label: '...',
        }
      case 'partial':
        return {
          icon: <InfoIcon size={variant === 'minimal' ? 10 : 14} color={tokens.colors.accent.warning} />,
          color: tokens.colors.accent.warning,
          bgColor: `${tokens.colors.accent.warning}10`,
          borderColor: `${tokens.colors.accent.warning}25`,
          label: '~',
        }
      case 'stale':
        return {
          icon: <WarningIcon size={variant === 'minimal' ? 10 : 14} color={tokens.colors.accent.error} />,
          color: tokens.colors.accent.error,
          bgColor: `${tokens.colors.accent.error}10`,
          borderColor: `${tokens.colors.accent.error}25`,
          label: '!',
        }
      case 'calculating':
        return {
          icon: (
            <Box
              style={{
                width: variant === 'minimal' ? 10 : 14,
                height: variant === 'minimal' ? 10 : 14,
                borderRadius: tokens.radius.full,
                border: `2px solid ${tokens.colors.accent.primary}`,
                borderTopColor: 'transparent',
                animation: 'spin 1s linear infinite',
              }}
            />
          ),
          color: tokens.colors.accent.primary,
          bgColor: `${tokens.colors.accent.primary}10`,
          borderColor: `${tokens.colors.accent.primary}25`,
          label: '...',
        }
      default:
        return {
          icon: <InfoIcon size={variant === 'minimal' ? 10 : 14} color={tokens.colors.text.tertiary} />,
          color: tokens.colors.text.tertiary,
          bgColor: `${tokens.colors.text.tertiary}08`,
          borderColor: `${tokens.colors.text.tertiary}15`,
          label: '—',
        }
    }
  }

  const config = getStatusConfig()
  const reasonText = getDefaultReason()

  // Minimal variant - just a dash with tooltip
  if (variant === 'minimal') {
    return (
      <Box
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: 0.5,
          cursor: showExplanation ? 'help' : 'default',
          ...style,
        }}
        title={showExplanation ? reasonText : undefined}
      >
        {children || (
          <Text size="sm" color="tertiary" style={{ fontSize: '13px' }}>
            {config.label}
          </Text>
        )}
      </Box>
    )
  }

  // Inline variant - small indicator with optional tooltip
  if (variant === 'inline') {
    return (
      <Box
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: tokens.spacing[1],
          padding: '2px 6px',
          borderRadius: tokens.radius.md,
          background: config.bgColor,
          border: `1px solid ${config.borderColor}`,
          cursor: showExplanation ? 'help' : 'default',
          ...style,
        }}
        title={showExplanation ? reasonText : undefined}
      >
        {config.icon}
        {children || (
          <Text size="xs" style={{ color: config.color, fontSize: '10px', fontWeight: 500 }}>
            {language === 'zh' ? '暂无' : 'N/A'}
          </Text>
        )}
      </Box>
    )
  }

  // Card variant - full explanation card
  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[3],
        padding: tokens.spacing[6],
        borderRadius: tokens.radius.lg,
        background: config.bgColor,
        border: `1px dashed ${config.borderColor}`,
        textAlign: 'center',
        minHeight: 120,
        ...style,
      }}
    >
      <Box
        style={{
          width: 40,
          height: 40,
          borderRadius: tokens.radius.full,
          background: `${config.color}15`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {config.icon}
      </Box>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
        {metricName && (
          <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
            {metricName}
          </Text>
        )}
        <Text size="sm" color="tertiary">
          {reasonText}
        </Text>
      </Box>

      {children}
    </Box>
  )
}

/**
 * 条件渲染组件
 * 如果数据不可用，自动渲染占位符；否则渲染子组件
 */
export function DataOrPlaceholder({
  value,
  availability = 'available',
  exchange,
  metricName,
  reason,
  variant = 'minimal',
  children,
  fallback,
}: {
  value: unknown
  availability?: DataAvailability
  exchange?: Exchange | string
  metricName?: string
  reason?: { zh: string; en: string }
  variant?: 'inline' | 'card' | 'minimal'
  children: ReactNode
  fallback?: ReactNode
}) {
  // 检查值是否有效
  const isValueValid = value !== null && value !== undefined && value !== ''

  // 如果数据不可用或值无效，显示占位符
  if (availability !== 'available' || !isValueValid) {
    return fallback || (
      <MissingDataPlaceholder
        availability={availability !== 'available' ? availability : 'unavailable'}
        exchange={exchange}
        metricName={metricName}
        reason={reason}
        variant={variant}
      />
    )
  }

  return <>{children}</>
}

/**
 * 数据可用性指示器
 * 用于在表头或标签旁显示数据状态
 */
export function DataAvailabilityIndicator({
  availability,
  showLabel = false,
  size = 'sm',
}: {
  availability: DataAvailability
  showLabel?: boolean
  size?: 'xs' | 'sm' | 'md'
}) {
  const { language } = useLanguage()

  const sizeMap = {
    xs: { dot: 4, fontSize: '9px', padding: '1px 4px' },
    sm: { dot: 6, fontSize: '10px', padding: '2px 6px' },
    md: { dot: 8, fontSize: '11px', padding: '3px 8px' },
  }

  const config = sizeMap[size]

  const getStatusColor = () => {
    switch (availability) {
      case 'available':
        return tokens.colors.accent.success
      case 'delayed':
      case 'partial':
        return tokens.colors.accent.warning
      case 'stale':
      case 'unavailable':
        return tokens.colors.accent.error
      case 'calculating':
        return tokens.colors.accent.primary
      default:
        return tokens.colors.text.tertiary
    }
  }

  const getStatusLabel = () => {
    switch (availability) {
      case 'available':
        return language === 'zh' ? '可用' : 'OK'
      case 'delayed':
        return language === 'zh' ? '延迟' : 'Delayed'
      case 'partial':
        return language === 'zh' ? '部分' : 'Partial'
      case 'stale':
        return language === 'zh' ? '过期' : 'Stale'
      case 'unavailable':
        return language === 'zh' ? '不可用' : 'N/A'
      case 'calculating':
        return language === 'zh' ? '计算中' : 'Loading'
      default:
        return '?'
    }
  }

  const color = getStatusColor()

  if (!showLabel) {
    return (
      <Box
        style={{
          width: config.dot,
          height: config.dot,
          borderRadius: tokens.radius.full,
          background: color,
          flexShrink: 0,
        }}
        title={getStatusLabel()}
      />
    )
  }

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: config.padding,
        borderRadius: tokens.radius.full,
        background: `${color}15`,
        border: `1px solid ${color}30`,
      }}
    >
      <Box
        style={{
          width: config.dot,
          height: config.dot,
          borderRadius: tokens.radius.full,
          background: color,
        }}
      />
      <Text size="xs" style={{ color, fontWeight: 500, fontSize: config.fontSize }}>
        {getStatusLabel()}
      </Text>
    </Box>
  )
}

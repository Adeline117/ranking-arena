'use client'

import { useState, useRef, useEffect, ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { MetricProvenance, DataAvailability } from '@/lib/types/data-provenance'
import { formatLastUpdated } from '@/lib/types/data-provenance'

// Info icon SVG
const InfoIcon = ({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" strokeLinecap="round" />
    <circle cx="12" cy="8" r="0.5" fill={color} stroke="none" />
  </svg>
)

// Check icon for available status
const CheckIcon = ({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5">
    <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// Warning icon for partial/delayed data
const WarningIcon = ({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  </svg>
)

// X icon for unavailable data
const XIcon = ({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5">
    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
  </svg>
)

interface DataSourceTooltipProps {
  children: ReactNode
  provenance: MetricProvenance
  /** 显示模式：inline = 内联小图标，badge = 状态徽章 */
  mode?: 'inline' | 'badge'
  /** 是否显示触发图标 */
  showIcon?: boolean
}

/**
 * 数据来源提示组件
 * 点击/悬停时显示数据来源、更新时间、计算口径等信息
 */
export default function DataSourceTooltip({
  children,
  provenance,
  mode = 'inline',
  showIcon = true,
}: DataSourceTooltipProps) {
  const { language } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // 获取状态图标和颜色
  const getStatusInfo = (availability: DataAvailability) => {
    switch (availability) {
      case 'available':
        return {
          icon: <CheckIcon size={10} color={tokens.colors.accent.success} />,
          color: tokens.colors.accent.success,
          label: language === 'zh' ? '数据可用' : 'Available',
        }
      case 'delayed':
        return {
          icon: <WarningIcon size={10} color={tokens.colors.accent.warning} />,
          color: tokens.colors.accent.warning,
          label: language === 'zh' ? '数据延迟' : 'Delayed',
        }
      case 'partial':
        return {
          icon: <WarningIcon size={10} color={tokens.colors.accent.warning} />,
          color: tokens.colors.accent.warning,
          label: language === 'zh' ? '部分可用' : 'Partial',
        }
      case 'stale':
        return {
          icon: <WarningIcon size={10} color={tokens.colors.accent.error} />,
          color: tokens.colors.accent.error,
          label: language === 'zh' ? '数据过期' : 'Stale',
        }
      case 'unavailable':
        return {
          icon: <XIcon size={10} color={tokens.colors.text.tertiary} />,
          color: tokens.colors.text.tertiary,
          label: language === 'zh' ? '暂不支持' : 'Unavailable',
        }
      case 'calculating':
        return {
          icon: <InfoIcon size={10} color={tokens.colors.accent.primary} />,
          color: tokens.colors.accent.primary,
          label: language === 'zh' ? '计算中' : 'Calculating',
        }
      default:
        return {
          icon: <InfoIcon size={10} color={tokens.colors.text.tertiary} />,
          color: tokens.colors.text.tertiary,
          label: language === 'zh' ? '未知' : 'Unknown',
        }
    }
  }

  const statusInfo = getStatusInfo(provenance.availability)

  // 计算 tooltip 位置
  useEffect(() => {
    if (isOpen && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect()
      const tooltipRect = tooltipRef.current.getBoundingClientRect()

      let top = triggerRect.bottom + 8
      let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2

      // 确保不超出视口
      if (left < 8) left = 8
      if (left + tooltipRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tooltipRect.width - 8
      }
      if (top + tooltipRect.height > window.innerHeight - 8) {
        top = triggerRect.top - tooltipRect.height - 8
      }

      setPosition({ top, left })
    }
  }, [isOpen])

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node) &&
        tooltipRef.current &&
        !tooltipRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  return (
    <Box style={{ display: 'inline-flex', alignItems: 'center', gap: 4, position: 'relative' }}>
      {children}

      {showIcon && (
        <div
          ref={triggerRef}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setIsOpen(!isOpen)
          }}
          onMouseEnter={() => setIsOpen(true)}
          onMouseLeave={() => setIsOpen(false)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 2,
            borderRadius: tokens.radius.sm,
            transition: tokens.transition.fast,
          }}
        >
          {mode === 'badge' ? (
            <Box
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                padding: '2px 6px',
                borderRadius: tokens.radius.full,
                background: `${statusInfo.color}15`,
                border: `1px solid ${statusInfo.color}30`,
              }}
            >
              {statusInfo.icon}
              <Text
                size="xs"
                style={{
                  color: statusInfo.color,
                  fontSize: '9px',
                  fontWeight: 600,
                  lineHeight: 1,
                }}
              >
                {statusInfo.label}
              </Text>
            </Box>
          ) : (
            <InfoIcon size={11} color={tokens.colors.text.tertiary} />
          )}
        </div>
      )}

      {/* Tooltip */}
      {isOpen && (
        <div
          ref={tooltipRef}
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            zIndex: tokens.zIndex.tooltip,
            minWidth: 240,
            maxWidth: 320,
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            boxShadow: tokens.shadow.lg,
            backdropFilter: tokens.glass.blur.md,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[3],
              paddingBottom: tokens.spacing[2],
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Box
              style={{
                width: 20,
                height: 20,
                borderRadius: tokens.radius.full,
                background: `${statusInfo.color}20`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {statusInfo.icon}
            </Box>
            <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
              {provenance.metricName}
            </Text>
            <Box
              style={{
                marginLeft: 'auto',
                padding: '2px 8px',
                borderRadius: tokens.radius.full,
                background: `${statusInfo.color}15`,
              }}
            >
              <Text size="xs" style={{ color: statusInfo.color, fontWeight: 600 }}>
                {statusInfo.label}
              </Text>
            </Box>
          </Box>

          {/* Source Info */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {/* Data Source */}
            <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
              <Text
                size="xs"
                color="tertiary"
                style={{ minWidth: 60, flexShrink: 0 }}
              >
                {language === 'zh' ? '数据来源' : 'Source'}
              </Text>
              <Text size="xs" style={{ color: tokens.colors.text.secondary }}>
                {provenance.sourceDescription[language]}
              </Text>
            </Box>

            {/* Last Updated */}
            {provenance.lastUpdated && (
              <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
                <Text
                  size="xs"
                  color="tertiary"
                  style={{ minWidth: 60, flexShrink: 0 }}
                >
                  {language === 'zh' ? '更新时间' : 'Updated'}
                </Text>
                <Text size="xs" style={{ color: tokens.colors.text.secondary }}>
                  {formatLastUpdated(provenance.lastUpdated, language)}
                </Text>
              </Box>
            )}

            {/* Window Definition */}
            {provenance.windowDefinition && (
              <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
                <Text
                  size="xs"
                  color="tertiary"
                  style={{ minWidth: 60, flexShrink: 0 }}
                >
                  {language === 'zh' ? '时间窗口' : 'Window'}
                </Text>
                <Text size="xs" style={{ color: tokens.colors.text.secondary }}>
                  {provenance.windowDefinition[language]}
                </Text>
              </Box>
            )}

            {/* Calculation Method */}
            {provenance.calculationMethod && (
              <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
                <Text
                  size="xs"
                  color="tertiary"
                  style={{ minWidth: 60, flexShrink: 0 }}
                >
                  {language === 'zh' ? '计算方式' : 'Method'}
                </Text>
                <Text size="xs" style={{ color: tokens.colors.text.secondary }}>
                  {provenance.calculationMethod[language]}
                </Text>
              </Box>
            )}

            {/* Delay Info */}
            {provenance.delayInfo && (
              <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
                <Text
                  size="xs"
                  color="tertiary"
                  style={{ minWidth: 60, flexShrink: 0 }}
                >
                  {language === 'zh' ? '延迟说明' : 'Delay'}
                </Text>
                <Text size="xs" style={{ color: tokens.colors.accent.warning }}>
                  {provenance.delayInfo[language]}
                </Text>
              </Box>
            )}

            {/* Unavailable Reason */}
            {provenance.availability === 'unavailable' && provenance.unavailableReason && (
              <Box
                style={{
                  marginTop: tokens.spacing[2],
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  background: `${tokens.colors.text.tertiary}10`,
                }}
              >
                <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                  {provenance.unavailableReason[language]}
                </Text>
              </Box>
            )}

            {/* Confidence Score */}
            {provenance.confidence !== undefined && provenance.availability === 'available' && (
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  marginTop: tokens.spacing[1],
                }}
              >
                <Text
                  size="xs"
                  color="tertiary"
                  style={{ minWidth: 60, flexShrink: 0 }}
                >
                  {language === 'zh' ? '可信度' : 'Confidence'}
                </Text>
                <Box
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: tokens.radius.full,
                    background: tokens.colors.bg.tertiary,
                    overflow: 'hidden',
                  }}
                >
                  <Box
                    style={{
                      height: '100%',
                      width: `${provenance.confidence}%`,
                      borderRadius: tokens.radius.full,
                      background:
                        provenance.confidence >= 80
                          ? tokens.colors.accent.success
                          : provenance.confidence >= 50
                          ? tokens.colors.accent.warning
                          : tokens.colors.accent.error,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </Box>
                <Text size="xs" color="tertiary">
                  {provenance.confidence}%
                </Text>
              </Box>
            )}

            {/* Source URL */}
            {provenance.sourceUrl && (
              <Box style={{ marginTop: tokens.spacing[2] }}>
                <a
                  href={provenance.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.accent.primary,
                    textDecoration: 'none',
                  }}
                >
                  {language === 'zh' ? '查看原始数据' : 'View source'}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                  </svg>
                </a>
              </Box>
            )}
          </Box>
        </div>
      )}
    </Box>
  )
}

/**
 * 简化版数据来源标签
 * 用于快速显示数据来源状态
 */
export function DataSourceBadge({
  availability,
  exchange,
  lastUpdated,
  compact = false,
}: {
  availability: DataAvailability
  exchange?: string
  lastUpdated?: string
  compact?: boolean
}) {
  const { language } = useLanguage()

  const getStatusColor = (status: DataAvailability) => {
    switch (status) {
      case 'available':
        return tokens.colors.accent.success
      case 'delayed':
      case 'partial':
        return tokens.colors.accent.warning
      case 'stale':
      case 'unavailable':
        return tokens.colors.accent.error
      default:
        return tokens.colors.text.tertiary
    }
  }

  const statusColor = getStatusColor(availability)

  if (compact) {
    return (
      <Box
        style={{
          width: 6,
          height: 6,
          borderRadius: tokens.radius.full,
          background: statusColor,
        }}
        title={
          availability === 'available'
            ? language === 'zh'
              ? '数据可用'
              : 'Data available'
            : language === 'zh'
            ? '数据不可用'
            : 'Data unavailable'
        }
      />
    )
  }

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: tokens.radius.full,
        background: `${statusColor}15`,
        border: `1px solid ${statusColor}30`,
      }}
    >
      <Box
        style={{
          width: 5,
          height: 5,
          borderRadius: tokens.radius.full,
          background: statusColor,
        }}
      />
      <Text size="xs" style={{ color: statusColor, fontWeight: 500, fontSize: '10px' }}>
        {exchange?.toUpperCase()}
      </Text>
      {lastUpdated && (
        <Text size="xs" color="tertiary" style={{ fontSize: '9px' }}>
          {formatLastUpdated(lastUpdated, language)}
        </Text>
      )}
    </Box>
  )
}

'use client'

/**
 * Data Freshness Indicator Component
 * Shows the overall health and last update time of ranking data
 * Clicking opens a detailed view of all platform statuses
 */

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useDataFreshness, getOverallHealth } from '@/lib/hooks/useDataFreshness'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

const STATUS_COLORS = {
  healthy: tokens.colors.accent.success,
  warning: tokens.colors.accent.warning,
  critical: tokens.colors.accent.error,
  no_data: tokens.colors.text.tertiary,
}

const STATUS_BG = {
  healthy: `${tokens.colors.accent.success}15`,
  warning: `${tokens.colors.accent.warning}15`,
  critical: `${tokens.colors.accent.error}15`,
  no_data: `${tokens.colors.bg.tertiary}`,
}

function formatTimeAgo(ageHours: number | null, isZh: boolean): string {
  if (ageHours == null) return isZh ? '无数据' : 'No data'
  
  if (ageHours < 1) {
    const mins = Math.round(ageHours * 60)
    return isZh ? `${mins}分钟前` : `${mins}m ago`
  }
  
  if (ageHours < 24) {
    const hours = Math.round(ageHours)
    return isZh ? `${hours}小时前` : `${hours}h ago`
  }
  
  const days = Math.round(ageHours / 24)
  return isZh ? `${days}天前` : `${days}d ago`
}

function StatusIcon({ status }: { status: 'healthy' | 'warning' | 'critical' | 'no_data' }) {
  if (status === 'healthy') {
    return (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    )
  }
  if (status === 'warning') {
    return (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
    )
  }
  if (status === 'critical') {
    return (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M15 9l-6 6M9 9l6 6" />
      </svg>
    )
  }
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v.01M12 8v4" />
    </svg>
  )
}

export default function DataFreshnessIndicator() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const { data, isLoading, error } = useDataFreshness()
  const [showDetails, setShowDetails] = useState(false)

  if (isLoading || error || !data) {
    return null
  }

  const health = getOverallHealth(data)
  const lastCheck = new Date(data.timestamp).toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit' 
  })

  return (
    <div className="relative">
      {/* Indicator Button */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
        style={{
          backgroundColor: STATUS_BG[health.status],
          color: STATUS_COLORS[health.status],
          border: `1px solid ${STATUS_COLORS[health.status]}30`,
        }}
        title={isZh ? '点击查看数据状态详情' : 'Click to view data status details'}
      >
        <StatusIcon status={health.status} />
        <span className="hidden sm:inline">
          {isZh ? '数据状态' : 'Data Status'}
        </span>
        <svg 
          width={10} 
          height={10} 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2"
          style={{ 
            transform: showDetails ? 'rotate(180deg)' : 'rotate(0deg)', 
            transition: 'transform 0.2s' 
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Details Dropdown */}
      {showDetails && (
        <>
          {/* Backdrop */}
          <div 
            className="fixed inset-0 z-40"
            onClick={() => setShowDetails(false)}
          />
          
          {/* Dropdown Panel */}
          <div
            className="absolute right-0 top-full mt-2 z-50 w-80 max-h-96 overflow-y-auto rounded-xl shadow-xl"
            style={{
              backgroundColor: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            {/* Header */}
            <div 
              className="sticky top-0 px-4 py-3 border-b"
              style={{ 
                backgroundColor: tokens.colors.bg.secondary,
                borderColor: tokens.colors.border.primary 
              }}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold" style={{ color: tokens.colors.text.primary }}>
                  {isZh ? '数据新鲜度' : 'Data Freshness'}
                </h3>
                <span className="text-xs" style={{ color: tokens.colors.text.tertiary }}>
                  {isZh ? `检查于 ${lastCheck}` : `Checked at ${lastCheck}`}
                </span>
              </div>
              
              {/* Summary */}
              <div className="flex gap-3 mt-2">
                <span className="text-xs" style={{ color: STATUS_COLORS.healthy }}>
                  ✓ {data.summary.healthy}
                </span>
                <span className="text-xs" style={{ color: STATUS_COLORS.warning }}>
                  ⚠ {data.summary.warning}
                </span>
                <span className="text-xs" style={{ color: STATUS_COLORS.critical }}>
                  ✕ {data.summary.critical}
                </span>
              </div>
            </div>

            {/* Platform List */}
            <div className="divide-y" style={{ borderColor: tokens.colors.border.primary + '40' }}>
              {data.platforms.map((platform) => (
                <div
                  key={platform.source}
                  className="px-4 py-2.5 flex items-center justify-between"
                  style={{
                    backgroundColor: platform.status === 'critical' 
                      ? `${STATUS_COLORS.critical}08` 
                      : 'transparent',
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div 
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: STATUS_COLORS[platform.status] }}
                    />
                    <span 
                      className="text-xs font-medium truncate"
                      style={{ 
                        color: platform.status === 'critical' 
                          ? STATUS_COLORS.critical 
                          : tokens.colors.text.primary 
                      }}
                    >
                      {EXCHANGE_NAMES[platform.source] || platform.source}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <span 
                      className="text-xs"
                      style={{ 
                        color: platform.status === 'healthy' 
                          ? tokens.colors.text.tertiary 
                          : STATUS_COLORS[platform.status] 
                      }}
                    >
                      {formatTimeAgo(platform.ageHours, isZh)}
                    </span>
                    <span 
                      className="text-xs tabular-nums"
                      style={{ color: tokens.colors.text.tertiary }}
                    >
                      {platform.total > 0 ? platform.total : '—'}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div 
              className="sticky bottom-0 px-4 py-2 border-t text-center"
              style={{ 
                backgroundColor: tokens.colors.bg.secondary,
                borderColor: tokens.colors.border.primary 
              }}
            >
              <a
                href="/api/monitoring/freshness?format=html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs transition-colors"
                style={{ color: tokens.colors.accent.brand }}
              >
                {isZh ? '查看完整报告 →' : 'View full report →'}
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

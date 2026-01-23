'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface TraderRefreshButtonProps {
  isRefreshing: boolean
  isStale: boolean
  onRefresh: () => void
  refreshError: string | null
  updatedAt: string | null
  refreshJob?: {
    status: string
    attempts: number
  } | null
}

export default function TraderRefreshButton({
  isRefreshing,
  isStale,
  onRefresh,
  refreshError,
  updatedAt,
  refreshJob,
}: TraderRefreshButtonProps) {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const formatTimeAgo = (dateStr: string): string => {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
    if (seconds < 60) return isZh ? '刚刚' : 'Just now'
    if (seconds < 3600) {
      const mins = Math.floor(seconds / 60)
      return isZh ? `${mins} 分钟前` : `${mins}m ago`
    }
    if (seconds < 86400) {
      const hrs = Math.floor(seconds / 3600)
      return isZh ? `${hrs} 小时前` : `${hrs}h ago`
    }
    const days = Math.floor(seconds / 86400)
    return isZh ? `${days} 天前` : `${days}d ago`
  }

  const isJobActive = refreshJob && (refreshJob.status === 'pending' || refreshJob.status === 'running')
  const showSpinner = isRefreshing || isJobActive

  return (
    <div className="flex items-center gap-2 text-sm">
      {updatedAt && (
        <span style={{ color: tokens.colors.text.secondary }}>
          {isZh ? '更新于' : 'Updated'} {formatTimeAgo(updatedAt)}
        </span>
      )}

      {isStale && !showSpinner && (
        <span
          className="px-2 py-0.5 rounded text-xs font-medium"
          style={{
            backgroundColor: `${tokens.colors.accent.warning}20`,
            color: tokens.colors.accent.warning,
          }}
        >
          {isZh ? '数据过期' : 'Stale'}
        </span>
      )}

      <button
        onClick={onRefresh}
        disabled={!!showSpinner}
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          backgroundColor: showSpinner ? tokens.colors.bg.secondary : tokens.colors.accent.brand + '15',
          color: showSpinner ? tokens.colors.text.secondary : tokens.colors.accent.brand,
          border: `1px solid ${showSpinner ? tokens.colors.border.primary : tokens.colors.accent.brand + '30'}`,
        }}
      >
        {showSpinner ? (
          <>
            <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {isZh ? '刷新中...' : 'Refreshing...'}
          </>
        ) : (
          <>
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {isZh ? '刷新数据' : 'Refresh'}
          </>
        )}
      </button>

      {refreshError && (
        <span className="text-xs" style={{ color: tokens.colors.accent.error }}>{refreshError}</span>
      )}
    </div>
  )
}

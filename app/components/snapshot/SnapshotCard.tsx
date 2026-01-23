'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

// Icons
const ShareIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
  </svg>
)

const CopyIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
)

const CheckIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ClockIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
)

const TrophyIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 9H4a2 2 0 01-2-2V5a2 2 0 012-2h2M18 9h2a2 2 0 002-2V5a2 2 0 00-2-2h-2M6 9v3a6 6 0 0012 0V9M6 9h12M9 21h6M12 17v4" />
  </svg>
)

interface SnapshotTrader {
  rank: number
  id: string
  handle?: string
  source: string
  roi: number | null
  pnl?: number | null
  winRate?: number | null
  maxDrawdown?: number | null
  arenaScore?: number | null
}

interface SnapshotData {
  id: string
  shareToken: string
  timeRange: string
  exchange?: string
  category?: string
  totalTraders: number
  topTrader: {
    handle: string
    roi: number
  }
  dataCapturedAt: string
  dataDelayMinutes?: number
  viewCount?: number
  expiresAt?: string
  title?: string
  description?: string
  createdAt: string
}

interface SnapshotCardProps {
  snapshot: SnapshotData
  traders: SnapshotTrader[]
  /** Show full card or compact preview */
  variant?: 'full' | 'compact' | 'preview'
  /** Show share actions */
  showActions?: boolean
  /** Custom base URL for sharing */
  baseUrl?: string
}

/**
 * Snapshot Card Component
 * Displays a ranking snapshot with share functionality
 */
export default function SnapshotCard({
  snapshot,
  traders,
  variant = 'full',
  showActions = true,
  baseUrl = '',
}: SnapshotCardProps) {
  const { t, language } = useLanguage()
  const [copied, setCopied] = useState(false)

  const shareUrl = `${baseUrl}/s/${snapshot.shareToken}`

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy link:', error)
    }
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatROI = (roi: number) => {
    const sign = roi >= 0 ? '+' : ''
    if (Math.abs(roi) >= 1000) {
      return `${sign}${(roi / 1000).toFixed(1)}K%`
    }
    return `${sign}${roi.toFixed(1)}%`
  }

  const getTimeRangeLabel = (range: string) => {
    const labels: Record<string, { zh: string; en: string }> = {
      '7D': { zh: '7天', en: '7 Days' },
      '30D': { zh: '30天', en: '30 Days' },
      '90D': { zh: '90天', en: '90 Days' },
    }
    return labels[range]?.[language] || range
  }

  const isExpired = snapshot.expiresAt && new Date(snapshot.expiresAt) < new Date()

  // Compact preview for list view
  if (variant === 'compact') {
    return (
      <Box
        style={{
          padding: tokens.spacing[3],
          borderRadius: tokens.radius.lg,
          background: tokens.glass.bg.light,
          border: tokens.glass.border.light,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[3],
          opacity: isExpired ? 0.6 : 1,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], flex: 1, minWidth: 0 }}>
          <Box
            style={{
              width: 36,
              height: 36,
              borderRadius: tokens.radius.md,
              background: tokens.gradient.primarySubtle,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <TrophyIcon size={18} />
          </Box>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text
              size="sm"
              weight="bold"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {snapshot.title || `${getTimeRangeLabel(snapshot.timeRange)} ${t('ranking')}`}
            </Text>
            <Text size="xs" color="tertiary">
              {formatDate(snapshot.createdAt)} · {snapshot.totalTraders} {language === 'zh' ? '位交易员' : 'traders'}
            </Text>
          </Box>
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {isExpired ? (
            <Text size="xs" color="tertiary">
              {t('snapshotExpired')}
            </Text>
          ) : (
            <button
              onClick={handleCopyLink}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                background: copied ? tokens.colors.accent.success : tokens.colors.bg.tertiary,
                border: `1px solid ${copied ? tokens.colors.accent.success : tokens.colors.border.primary}`,
                color: copied ? '#fff' : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: 500,
                transition: tokens.transition.fast,
              }}
            >
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              {copied ? (language === 'zh' ? '已复制' : 'Copied') : t('copySnapshotLink')}
            </button>
          )}
        </Box>
      </Box>
    )
  }

  // Full card view
  return (
    <Box
      style={{
        borderRadius: tokens.radius.xl,
        background: tokens.glass.bg.secondary,
        border: tokens.glass.border.medium,
        overflow: 'hidden',
        boxShadow: tokens.shadow.lg,
      }}
    >
      {/* Header */}
      <Box
        style={{
          padding: tokens.spacing[4],
          background: tokens.gradient.primarySubtle,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: tokens.spacing[3] }}>
          <Box style={{ flex: 1 }}>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
              {snapshot.title || `${getTimeRangeLabel(snapshot.timeRange)} ${t('snapshot')}`}
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], flexWrap: 'wrap' }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <ClockIcon size={12} />
                <Text size="xs" color="tertiary">
                  {formatDate(snapshot.dataCapturedAt)}
                </Text>
              </Box>
              {snapshot.dataDelayMinutes && (
                <Text size="xs" color="tertiary">
                  {t('snapshotDelayNote').replace('{minutes}', String(snapshot.dataDelayMinutes))}
                </Text>
              )}
            </Box>
          </Box>
          <Box
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.full,
              background: tokens.colors.accent.primary + '20',
              border: `1px solid ${tokens.colors.accent.primary}40`,
            }}
          >
            <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary }}>
              {t('snapshotTop').replace('{count}', String(snapshot.totalTraders))}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Top 3 Traders Preview */}
      <Box style={{ padding: tokens.spacing[4] }}>
        <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
          {language === 'zh' ? '榜单前三' : 'Top 3'}
        </Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {traders.slice(0, 3).map((trader, index) => (
            <Box
              key={trader.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.lg,
                background:
                  index === 0
                    ? 'linear-gradient(135deg, rgba(255, 215, 0, 0.15) 0%, rgba(255, 215, 0, 0.05) 100%)'
                    : index === 1
                    ? 'linear-gradient(135deg, rgba(192, 192, 192, 0.15) 0%, rgba(192, 192, 192, 0.05) 100%)'
                    : index === 2
                    ? 'linear-gradient(135deg, rgba(205, 127, 50, 0.15) 0%, rgba(205, 127, 50, 0.05) 100%)'
                    : tokens.glass.bg.light,
                border: `1px solid ${
                  index === 0
                    ? 'rgba(255, 215, 0, 0.3)'
                    : index === 1
                    ? 'rgba(192, 192, 192, 0.3)'
                    : index === 2
                    ? 'rgba(205, 127, 50, 0.3)'
                    : tokens.colors.border.primary
                }`,
              }}
            >
              {/* Rank */}
              <Text
                size="lg"
                weight="black"
                style={{
                  color:
                    index === 0
                      ? '#FFD700'
                      : index === 1
                      ? '#C0C0C0'
                      : index === 2
                      ? '#CD7F32'
                      : tokens.colors.text.secondary,
                  minWidth: 24,
                  textAlign: 'center',
                }}
              >
                {trader.rank}
              </Text>

              {/* Trader Info */}
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text
                  size="sm"
                  weight="bold"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {trader.handle || trader.id}
                </Text>
                <Text size="xs" color="tertiary" style={{ textTransform: 'uppercase' }}>
                  {trader.source}
                </Text>
              </Box>

              {/* ROI */}
              <Text
                size="md"
                weight="black"
                style={{
                  color:
                    trader.roi !== null && trader.roi >= 0
                      ? tokens.colors.accent.success
                      : tokens.colors.accent.error,
                }}
              >
                {trader.roi !== null ? formatROI(trader.roi) : '—'}
              </Text>

              {/* Arena Score */}
              {trader.arenaScore !== null && trader.arenaScore !== undefined && (
                <Box
                  style={{
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.md,
                    background:
                      trader.arenaScore >= 60
                        ? `${tokens.colors.accent.success}20`
                        : trader.arenaScore >= 40
                        ? `${tokens.colors.accent.warning}20`
                        : tokens.glass.bg.light,
                  }}
                >
                  <Text
                    size="xs"
                    weight="bold"
                    style={{
                      color:
                        trader.arenaScore >= 60
                          ? tokens.colors.accent.success
                          : trader.arenaScore >= 40
                          ? tokens.colors.accent.warning
                          : tokens.colors.text.secondary,
                    }}
                  >
                    {trader.arenaScore.toFixed(1)}
                  </Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      </Box>

      {/* Disclaimer */}
      <Box
        style={{
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.glass.bg.light,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" color="tertiary" style={{ lineHeight: 1.5 }}>
          {t('snapshotDisclaimer')}
        </Text>
      </Box>

      {/* Actions */}
      {showActions && !isExpired && (
        <Box
          style={{
            padding: tokens.spacing[4],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
          }}
        >
          <button
            onClick={handleCopyLink}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              background: copied ? tokens.colors.accent.success : tokens.gradient.primary,
              border: 'none',
              color: '#fff',
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              transition: tokens.transition.fast,
            }}
          >
            {copied ? <CheckIcon size={16} /> : <ShareIcon size={16} />}
            {copied ? (language === 'zh' ? '链接已复制' : 'Link Copied') : t('shareSnapshot')}
          </button>
        </Box>
      )}

      {/* Expired overlay */}
      {isExpired && (
        <Box
          style={{
            padding: tokens.spacing[4],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            background: `${tokens.colors.accent.error}10`,
            textAlign: 'center',
          }}
        >
          <Text size="sm" style={{ color: tokens.colors.accent.error }}>
            {t('snapshotExpired')}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Snapshot Create Button Component
 */
export function CreateSnapshotButton({
  timeRange,
  exchange,
  onSuccess,
  disabled = false,
}: {
  timeRange: string
  exchange?: string
  onSuccess?: (snapshot: { shareToken: string; shareUrl: string }) => void
  disabled?: boolean
}) {
  const { t } = useLanguage()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeRange, exchange }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create snapshot')
      }

      onSuccess?.(data.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      <button
        onClick={handleCreate}
        disabled={disabled || loading}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.md,
          background: disabled || loading ? tokens.colors.bg.tertiary : tokens.gradient.primary,
          border: 'none',
          color: '#fff',
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: 600,
          opacity: disabled ? 0.5 : 1,
          transition: tokens.transition.fast,
        }}
      >
        {loading ? (
          <>
            <Box
              style={{
                width: 14,
                height: 14,
                borderRadius: tokens.radius.full,
                border: '2px solid #fff',
                borderTopColor: 'transparent',
                animation: 'spin 1s linear infinite',
              }}
            />
            {t('snapshotGenerating')}
          </>
        ) : (
          <>
            <ShareIcon size={14} />
            {t('createSnapshot')}
          </>
        )}
      </button>
      {error && (
        <Text size="xs" style={{ color: tokens.colors.accent.error }}>
          {error}
        </Text>
      )}
    </Box>
  )
}

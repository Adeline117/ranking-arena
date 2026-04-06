'use client'

import { useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { logger } from '@/lib/logger'

// Icons
const ShareIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
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

const EyeIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const ArrowLeftIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
)

const WarningIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  </svg>
)

interface SnapshotTrader {
  rank: number
  id: string
  handle?: string
  source: string
  avatarUrl?: string
  roi: number | null
  pnl?: number | null
  winRate?: number | null
  maxDrawdown?: number | null
  tradesCount?: number | null
  followers?: number | null
  arenaScore?: number | null
  returnScore?: number | null
  drawdownScore?: number | null
  stabilityScore?: number | null
  dataAvailability?: Record<string, boolean>
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
  isExpired?: boolean
}

interface SnapshotViewerClientProps {
  snapshot: SnapshotData
  traders: SnapshotTrader[]
}

export default function SnapshotViewerClient({ snapshot, traders }: SnapshotViewerClientProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const [copied, setCopied] = useState(false)

  const shareUrl = typeof window !== 'undefined' ? window.location.href : `/s/${snapshot.shareToken}`

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      showToast(t('copiedToClipboard'), 'success')
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      logger.error('Failed to copy link:', error)
      showToast(t('copyFailed') || 'Copy failed', 'error')
    }
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString(({ zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' } as Record<string, string>)[language] || 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatROI = (roi: number) => {
    const sign = roi >= 0 ? '+' : ''
    if (Math.abs(roi) >= 10000) {
      return `${sign}${(roi / 1000).toFixed(0)}K%`
    } else if (Math.abs(roi) >= 1000) {
      return `${sign}${roi.toFixed(0)}%`
    }
    return `${sign}${roi.toFixed(1)}%`
  }

  const formatPnL = (pnl: number): string => {
    const absPnL = Math.abs(pnl)
    if (absPnL >= 1000000) {
      return `$${(pnl / 1000000).toFixed(2)}M`
    } else if (absPnL >= 1000) {
      return `$${(pnl / 1000).toFixed(2)}K`
    }
    return `$${pnl.toFixed(2)}`
  }

  const getTimeRangeLabel = (range: string) => {
    const labels: Record<string, Record<string, string>> = {
      '7D': { zh: '7天', en: '7 Days', ja: '7日間', ko: '7일' },
      '30D': { zh: '30天', en: '30 Days', ja: '30日間', ko: '30일' },
      '90D': { zh: '90天', en: '90 Days', ja: '90日間', ko: '90일' },
    }
    return labels[range]?.[language] || labels[range]?.en || range
  }

  // Expired state
  if (snapshot.isExpired) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: tokens.spacing[4],
        }}
      >
        <Box
          style={{
            textAlign: 'center',
            maxWidth: 400,
            padding: tokens.spacing[8],
            borderRadius: tokens.radius.xl,
            background: tokens.glass.bg.secondary,
            border: tokens.glass.border.medium,
          }}
        >
          <Box
            style={{
              width: 64,
              height: 64,
              borderRadius: tokens.radius.full,
              background: `${tokens.colors.accent.warning}20`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              marginBottom: tokens.spacing[4],
            }}
          >
            <WarningIcon size={32} />
          </Box>
          <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {t('snapshotExpired')}
          </Text>
          <Text color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
            {t('snapshotExpiredDesc')}
          </Text>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
              borderRadius: tokens.radius.lg,
              background: tokens.gradient.primary,
              color: tokens.colors.white,
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            {t('backToHome')}
          </Link>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      {/* Header */}
      <Box
        style={{
          position: 'sticky',
          top: 0,
          zIndex: tokens.zIndex.sticky,
          background: tokens.glass.bg.heavy,
          backdropFilter: tokens.glass.blur.lg,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.spacing[4],
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Link
              href="/"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.tertiary,
                color: tokens.colors.text.secondary,
                textDecoration: 'none',
              }}
            >
              <ArrowLeftIcon size={18} />
            </Link>
            <Box>
              <Text size="md" weight="bold">
                {snapshot.title || `${getTimeRangeLabel(snapshot.timeRange)} ${t('snapshot')}`}
              </Text>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                <ClockIcon size={12} />
                <Text size="xs" color="tertiary">
                  {formatDate(snapshot.dataCapturedAt)}
                </Text>
                {snapshot.viewCount !== undefined && (
                  <>
                    <Text size="xs" color="tertiary">·</Text>
                    <EyeIcon size={12} />
                    <Text size="xs" color="tertiary">
                      {snapshot.viewCount.toLocaleString('en-US')}
                    </Text>
                  </>
                )}
              </Box>
            </Box>
          </Box>
          <button
            onClick={handleCopyLink}
            aria-label="Copy link"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              background: copied ? tokens.colors.accent.success : tokens.gradient.primary,
              border: 'none',
              color: tokens.colors.white,
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              transition: tokens.transition.fast,
            }}
          >
            {copied ? <CheckIcon size={14} /> : <ShareIcon size={14} />}
            {copied ? t('snapshotCopied') : t('shareSnapshot')}
          </button>
        </Box>
      </Box>

      {/* Content */}
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[4] }}>
        {/* Disclaimer Banner */}
        <Box
          style={{
            padding: tokens.spacing[4],
            marginBottom: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            background: `${tokens.colors.accent.warning}10`,
            border: `1px solid ${tokens.colors.accent.warning}30`,
          }}
        >
          <Text size="sm" style={{ color: tokens.colors.accent.warning }}>
            {t('snapshotDisclaimer')}
            {snapshot.dataDelayMinutes && (
              <> {t('snapshotDelayNote').replace('{minutes}', String(snapshot.dataDelayMinutes))}</>
            )}
          </Text>
        </Box>

        {/* Ranking Table */}
        <Box
          style={{
            borderRadius: tokens.radius.xl,
            background: tokens.glass.bg.secondary,
            border: tokens.glass.border.medium,
            overflow: 'hidden',
            boxShadow: tokens.shadow.lg,
          }}
        >
          {/* Table Header */}
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: '50px minmax(120px, 1.5fr) 70px 100px 70px 70px',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.glass.bg.light,
            }}
          >
            <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase' }}>
              {t('rank')}
            </Text>
            <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
              {t('trader')}
            </Text>
            <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase' }}>
              Score
            </Text>
            <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase' }}>
              ROI
            </Text>
            <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase' }}>
              Win%
            </Text>
            <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'right', textTransform: 'uppercase' }}>
              MDD
            </Text>
          </Box>

          {/* Table Rows */}
          {traders.map((trader) => {
            const displayName = trader.handle || trader.id
            const shortDisplayName =
              displayName.startsWith('0x') && displayName.length > 20
                ? `${displayName.substring(0, 6)}...${displayName.substring(displayName.length - 4)}`
                : displayName

            return (
              <Box
                key={`${trader.id}-${trader.rank}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '50px minmax(120px, 1.5fr) 70px 100px 70px 70px',
                  gap: tokens.spacing[2],
                  padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid var(--glass-border-light)`,
                  alignItems: 'center',
                  transition: 'background 0.2s',
                }}
              >
                {/* Rank */}
                <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {trader.rank <= 3 ? (
                    <Text
                      size="lg"
                      weight="black"
                      style={{
                        color:
                          trader.rank === 1
                            ? 'var(--color-medal-gold)'
                            : trader.rank === 2
                            ? 'var(--color-medal-silver)'
                            : 'var(--color-medal-bronze)',
                      }}
                    >
                      {trader.rank}
                    </Text>
                  ) : (
                    <Text size="sm" weight="bold" color="tertiary">
                      #{trader.rank}
                    </Text>
                  )}
                </Box>

                {/* Trader */}
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], minWidth: 0 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      minWidth: 32,
                      borderRadius: '50%',
                      background: getAvatarGradient(trader.id),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      position: 'relative',
                      border: `2px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <span
                      style={{
                        color: tokens.colors.white,
                        fontSize: '12px',
                        fontWeight: 900,
                        textShadow: '0 1px 3px var(--color-backdrop-heavy)',
                      }}
                    >
                      {getAvatarInitial(displayName)}
                    </span>
                    {trader.avatarUrl && (
                      <img
                        src={trader.avatarUrl.startsWith('data:') ? trader.avatarUrl : '/api/avatar?url=' + encodeURIComponent(trader.avatarUrl)}
                        alt={`${trader.handle || 'Trader'} avatar`}
                        width={36}
                        height={36}
                        loading="lazy"
                        style={{
                          position: 'absolute',
                          inset: 0,
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                        }}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none'
                        }}
                      />
                    )}
                  </div>
                  <Box style={{ minWidth: 0, flex: 1 }}>
                    <Text
                      size="sm"
                      weight="bold"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {shortDisplayName}
                    </Text>
                    <Text size="xs" color="tertiary" style={{ textTransform: 'uppercase' }}>
                      {trader.source}
                    </Text>
                  </Box>
                </Box>

                {/* Arena Score */}
                <Box style={{ display: 'flex', justifyContent: 'center' }}>
                  {trader.arenaScore !== null && trader.arenaScore !== undefined ? (
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
                        minWidth: 46,
                        textAlign: 'center',
                      }}
                    >
                      <Text
                        size="sm"
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
                  ) : (
                    <Text size="sm" color="tertiary">—</Text>
                  )}
                </Box>

                {/* ROI */}
                <Box style={{ textAlign: 'right' }}>
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
                  {trader.pnl !== null && trader.pnl !== undefined && (
                    <Text
                      size="xs"
                      style={{
                        color:
                          trader.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                        opacity: 0.8,
                      }}
                    >
                      {trader.pnl >= 0 ? '+' : ''}{formatPnL(trader.pnl)}
                    </Text>
                  )}
                </Box>

                {/* Win Rate */}
                <Text
                  size="sm"
                  weight="semibold"
                  style={{
                    textAlign: 'right',
                    color:
                      trader.winRate != null && trader.winRate > 50
                        ? tokens.colors.accent.success
                        : tokens.colors.text.secondary,
                  }}
                >
                  {trader.winRate != null ? `${trader.winRate.toFixed(0)}%` : '—'}
                </Text>

                {/* Max Drawdown */}
                <Text
                  size="sm"
                  weight="semibold"
                  style={{
                    textAlign: 'right',
                    color: trader.maxDrawdown != null ? tokens.colors.accent.error : tokens.colors.text.tertiary,
                  }}
                >
                  {trader.maxDrawdown != null ? `-${Math.abs(trader.maxDrawdown).toFixed(0)}%` : '—'}
                </Text>
              </Box>
            )
          })}
        </Box>

        {/* Footer */}
        <Box
          style={{
            marginTop: tokens.spacing[6],
            textAlign: 'center',
          }}
        >
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
            {t('snapshotWantLive')}
          </Text>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
              borderRadius: tokens.radius.lg,
              background: tokens.gradient.primary,
              color: tokens.colors.white,
              textDecoration: 'none',
              fontWeight: 600,
              boxShadow: tokens.shadow.md,
            }}
          >
            {t('snapshotViewLive')}
          </Link>
        </Box>
      </Box>
    </Box>
  )
}

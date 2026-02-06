'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface FollowedTradersStats {
  count: number
  avgRoi: number
  bestPerformer: { handle: string; roi: number } | null
  worstPerformer: { handle: string; roi: number } | null
}

interface DashboardQuickStatsProps {
  userId: string
}

/**
 * Dashboard quick stats panel for user profile sidebar
 * Shows followed traders summary and quick navigation
 */
export default function DashboardQuickStats({ userId }: DashboardQuickStatsProps) {
  const { t } = useLanguage()
  const [stats, setStats] = useState<FollowedTradersStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchStats() {
      try {
        const response = await fetch(`/api/following?userId=${userId}`)
        if (!response.ok) throw new Error('Failed to fetch')

        const data = await response.json()
        const traders = (data.items || []).filter((item: { type: string }) => item.type === 'trader')

        if (traders.length === 0) {
          setStats({ count: 0, avgRoi: 0, bestPerformer: null, worstPerformer: null })
        } else {
          const rois = traders.map((t: { roi?: number }) => t.roi || 0)
          const avgRoi = rois.reduce((sum: number, r: number) => sum + r, 0) / rois.length

          const sortedByRoi = [...traders].sort((a: { roi?: number }, b: { roi?: number }) => (b.roi || 0) - (a.roi || 0))
          const best = sortedByRoi[0]
          const worst = sortedByRoi[sortedByRoi.length - 1]

          setStats({
            count: traders.length,
            avgRoi,
            bestPerformer: best ? { handle: best.handle, roi: best.roi || 0 } : null,
            worstPerformer: worst ? { handle: worst.handle, roi: worst.roi || 0 } : null,
          })
        }
      } catch (error) {
        console.error('Failed to fetch following stats:', error)
        setStats(null)
      } finally {
        setLoading(false)
      }
    }

    fetchStats()
  }, [userId])

  const quickLinks = [
    { href: '/following', label: t('myFollowing') || 'My Following', icon: '👥' },
    { href: '/settings', label: t('settings') || 'Settings', icon: '⚙️' },
    { href: '/compare', label: t('compareTraders') || 'Compare Traders', icon: '📊' },
    { href: '/', label: t('rankings') || 'Rankings', icon: '🏆' },
  ]

  return (
    <Box
      bg="secondary"
      p={4}
      radius="lg"
      border="primary"
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}
    >
      <Text size="sm" weight="black" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
        {t('dashboard') || 'Dashboard'}
      </Text>

      {/* Followed Traders Summary */}
      <Box style={{
        padding: tokens.spacing[3],
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.md
      }}>
        <Text size="xs" color="tertiary" style={{ marginBottom: 8 }}>
          {t('followedTraders') || 'Followed Traders'}
        </Text>

        {loading ? (
          <Box className="skeleton" style={{ height: 60, borderRadius: 8 }} />
        ) : stats && stats.count > 0 ? (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text size="lg" weight="bold">{stats.count}</Text>
              <Text
                size="sm"
                weight="semibold"
                style={{
                  color: stats.avgRoi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
                }}
              >
                {stats.avgRoi >= 0 ? '+' : ''}{stats.avgRoi.toFixed(1)}% {t('avgRoiShort') || 'avg'}
              </Text>
            </Box>

            {stats.bestPerformer && (
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text size="xs" color="tertiary">{t('topPerformer') || 'Top'}: {stats.bestPerformer.handle}</Text>
                <Text size="xs" style={{ color: tokens.colors.accent.success }}>
                  +{stats.bestPerformer.roi.toFixed(1)}%
                </Text>
              </Box>
            )}
          </Box>
        ) : (
          <Text size="xs" color="tertiary">
            {t('noFollowedTraders') || 'No followed traders yet'}
          </Text>
        )}

        <Link
          href="/following"
          style={{
            display: 'block',
            marginTop: tokens.spacing[2],
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.accent.primary,
            textDecoration: 'none',
          }}
        >
          {t('viewAll') || 'View all'} →
        </Link>
      </Box>

      {/* Quick Links */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
        <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>
          {t('quickLinks') || 'Quick Links'}
        </Text>
        {quickLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
              textDecoration: 'none',
              transition: `all ${tokens.transition.fast}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.tertiary
              e.currentTarget.style.color = tokens.colors.text.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = tokens.colors.text.secondary
            }}
          >
            <span style={{ fontSize: 14 }}>{link.icon}</span>
            {link.label}
          </Link>
        ))}
      </Box>
    </Box>
  )
}

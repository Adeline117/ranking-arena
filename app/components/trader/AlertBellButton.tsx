'use client'

/**
 * AlertBellButton — surfaces the per-trader alert config on the trader profile
 * (A4 retention). The full AlertConfig UI + the check-trader-alerts cron
 * evaluation + notification delivery already existed, but there was NO entry
 * point on the trader page: users could Follow/Watchlist a trader but not
 * "notify me when this trader's rank/ROI/score moves". This bell closes that
 * gap by opening the existing AlertConfig in a modal — explicit opt-in per
 * trader (no notification spam), reusing all existing infra.
 */

import { useState, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { trackEvent } from '@/lib/analytics/track'

// Heavy config panel — load only when the modal opens (keeps the header light).
const AlertConfig = dynamic(() => import('@/app/components/alerts/AlertConfig'), { ssr: false })

interface AlertBellButtonProps {
  traderId: string
  traderHandle: string
  source?: string
}

export default function AlertBellButton({ traderId, traderHandle, source }: AlertBellButtonProps) {
  const { isLoggedIn, userId, accessToken } = useAuthSession()
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(false)

  const refreshActive = useCallback(() => {
    if (!isLoggedIn || !accessToken) {
      setActive(false)
      return
    }
    let cancelled = false
    const query = new URLSearchParams({ trader_id: traderId })
    if (source) query.set('source', source)
    fetch(`/api/trader-alerts?${query}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        // withAuth wraps in { success, data } for some routes and returns the
        // handler value directly for others — handle both shapes.
        const alerts = d?.data?.alerts ?? d?.alerts ?? []
        setActive(Array.isArray(alerts) && alerts.length > 0)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isLoggedIn, accessToken, traderId, source])

  useEffect(() => {
    const cleanup = refreshActive()
    return cleanup
  }, [refreshActive])

  const handleClick = () => {
    if (!isLoggedIn) {
      useLoginModal.getState().openLoginModal()
      return
    }
    trackEvent('create_trader_alert', { traderId, source: source || '', step: 'open' })
    setOpen(true)
  }

  return (
    <>
      <button
        onClick={handleClick}
        aria-label={active ? t('alertsActive') : t('setAlert')}
        aria-pressed={active}
        title={active ? t('alertsActive') : t('setAlert')}
        className="interactive-scale"
        style={{
          padding: '8px 12px',
          minHeight: 44,
          borderRadius: tokens.radius.lg,
          border: active
            ? `1px solid var(--color-accent-warning, #f59e0b)`
            : `1px solid ${tokens.colors.border.primary}`,
          background: active
            ? 'var(--color-accent-warning-10, rgba(245, 158, 11, 0.1))'
            : tokens.glass.bg.light,
          color: active ? 'var(--color-accent-warning, #f59e0b)' : tokens.colors.text.secondary,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.borderColor = 'var(--color-accent-warning, #f59e0b)'
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.borderColor = tokens.colors.border.primary
        }}
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill={active ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </button>

      <ModalOverlay
        open={open}
        onClose={() => {
          setOpen(false)
          refreshActive()
        }}
        label={t('setAlert')}
        maxWidth={480}
      >
        <div style={{ padding: 24 }}>
          <AlertConfig
            traderId={traderId}
            traderHandle={traderHandle}
            source={source}
            userId={userId ?? undefined}
          />
          <Link
            href="/saved?tab=alerts"
            onClick={() => setOpen(false)}
            aria-label={t('viewAllAlerts')}
            style={{
              display: 'inline-flex',
              minHeight: 44,
              alignItems: 'center',
              marginTop: tokens.spacing[3],
              color: tokens.colors.accent.primary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              textDecoration: 'none',
            }}
          >
            {t('viewAllAlerts')} →
          </Link>
        </div>
      </ModalOverlay>
    </>
  )
}

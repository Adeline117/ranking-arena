'use client'

/**
 * Account settings surface for real trader alerts.
 *
 * AlertConfig deliberately lives on a trader profile, where the user can see
 * the account they are configuring. This component provides the missing other
 * half: a truthful list of persisted alerts and a way to remove one. It never
 * manufactures local-only alert state.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Box, Text, Button } from '@/app/components/base'
import { tokens, alpha } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

interface TraderAlert {
  id: string
  trader_id: string
  source: string | null
  alert_roi_change: boolean
  alert_drawdown: boolean
  alert_score_change: boolean
  alert_rank_change: boolean
  enabled: boolean
}

function profileHref(alert: TraderAlert): string {
  const params = new URLSearchParams()
  if (alert.source) params.set('platform', alert.source)
  const query = params.toString()
  return `/trader/${encodeURIComponent(alert.trader_id)}${query ? `?${query}` : ''}`
}

export default function TraderAlertsManager() {
  const { accessToken, authChecked } = useAuthSession()
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [alerts, setAlerts] = useState<TraderAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const response = await fetch('/api/trader-alerts', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (response.status === 403) {
        setForbidden(true)
        setAlerts([])
        return
      }
      if (!response.ok) throw new Error('Failed to load trader alerts')
      const payload = await response.json()
      const next = payload?.data?.alerts ?? payload?.alerts ?? []
      setAlerts(Array.isArray(next) ? next : [])
      setForbidden(false)
    } catch {
      showToast(t('traderAlertsLoadFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }, [accessToken, showToast, t])

  useEffect(() => {
    if (!authChecked) return
    if (!accessToken) {
      setLoading(false)
      return
    }
    void load()
  }, [accessToken, authChecked, load])

  const remove = async (alert: TraderAlert) => {
    if (!window.confirm(t('traderAlertsRemoveConfirm'))) return
    setRemoving(alert.id)
    try {
      const response = await fetch(`/api/trader-alerts?id=${encodeURIComponent(alert.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
      })
      if (!response.ok) throw new Error('Failed to delete trader alert')
      setAlerts((current) => current.filter((item) => item.id !== alert.id))
      showToast(t('alertDisabled'), 'success')
    } catch {
      showToast(t('traderAlertsRemoveFailed'), 'error')
    } finally {
      setRemoving(null)
    }
  }

  if (loading) {
    return (
      <Text size="sm" color="tertiary">
        {t('loading')}
      </Text>
    )
  }

  if (forbidden) {
    return (
      <Text size="sm" color="secondary">
        {t('traderAlertsProRequired')}
      </Text>
    )
  }

  if (alerts.length === 0) {
    return (
      <Text size="sm" color="secondary">
        {t('traderAlertsNone')}
      </Text>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {alerts.map((alert) => {
        const conditions = [
          alert.alert_roi_change && t('alertRoiChangeLabel'),
          alert.alert_drawdown && t('alertDrawdownLabel'),
          alert.alert_score_change && 'Arena Score',
          alert.alert_rank_change && t('alertRankChangeLabel'),
        ].filter(Boolean)
        return (
          <Box
            key={alert.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: tokens.spacing[3],
              padding: tokens.spacing[3],
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              background: alpha(tokens.colors.bg.tertiary, 35),
            }}
          >
            <Box style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Link
                href={profileHref(alert)}
                style={{
                  color: tokens.colors.text.primary,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                {alert.trader_id}
              </Link>
              <Text size="xs" color="tertiary">
                {[alert.source, alert.enabled ? t('traderAlertsEnabled') : t('traderAlertsPaused')]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Text size="xs" color="secondary">
                {conditions.length > 0 ? conditions.join(' · ') : t('traderAlertsNoConditions')}
              </Text>
            </Box>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void remove(alert)}
              disabled={removing === alert.id}
              aria-label={t('traderAlertsRemove')}
            >
              {removing === alert.id ? t('loading') : t('traderAlertsRemove')}
            </Button>
          </Box>
        )
      })}
    </Box>
  )
}

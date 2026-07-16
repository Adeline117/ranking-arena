'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { Box, Text, Button } from '../base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import EmptyState from '@/app/components/ui/EmptyState'
import ErrorMessage from '@/app/components/ui/ErrorMessage'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

// Sub-components
import { AlertRow } from './AlertRowComponents'
import { AlertHistory, type HistoryItem } from './AlertHistory'

// ── Types ──────────────────────────────────────────────────────────────────

interface AlertConfigProps {
  traderId: string
  traderHandle: string
  source?: string
  userId?: string
  onClose?: () => void
}

interface AlertData {
  id?: string
  alert_roi_change: boolean
  roi_change_threshold: number
  alert_drawdown: boolean
  drawdown_threshold: number
  alert_score_change: boolean
  score_change_threshold: number
  alert_rank_change: boolean
  rank_change_threshold: number
  one_time: boolean
  enabled: boolean
}

interface AlertMutationResponse {
  error?: unknown
  data?: { alert?: { enabled?: unknown } }
}

const DEFAULT_ALERT: AlertData = {
  alert_roi_change: true,
  roi_change_threshold: 10,
  alert_drawdown: true,
  drawdown_threshold: 20,
  alert_score_change: false,
  score_change_threshold: 5,
  alert_rank_change: false,
  rank_change_threshold: 5,
  one_time: false,
  enabled: true,
}

// ── Component ──────────────────────────────────────────────────────────────

export default function AlertConfig({
  traderId,
  traderHandle,
  source,
  userId,
  onClose,
}: AlertConfigProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  // /api/trader-alerts and /api/alerts require the Authorization Bearer header
  // (server auth never reads cookies) — without it every call here 401'd.
  const { accessToken } = useAuthSession()
  const [alert, setAlert] = useState<AlertData>(DEFAULT_ALERT)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState(false)
  const toggleInFlightRef = useRef(false)

  const authHeaders = useCallback(
    (): Record<string, string> => (accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    [accessToken]
  )

  const fetchAlert = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setForbidden(false)
    if (!accessToken) {
      setLoadError(t('loginRequired'))
      setLoading(false)
      return
    }
    try {
      const query = new URLSearchParams({ trader_id: traderId })
      if (source) query.set('source', source)
      const res = await fetch(`/api/trader-alerts?${query}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(15_000),
      })
      const data = await res.json().catch(() => null)
      if (res.status === 403) {
        setForbidden(true)
        return
      }
      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string' && data.error.trim()
            ? data.error.trim()
            : t('adminLoadFailed')
        )
      }
      if (!Array.isArray(data?.data?.alerts)) {
        throw new Error(t('adminLoadFailed'))
      }

      if (data.data.alerts.length > 0) {
        const existing = data.data.alerts[0]
        setAlert({
          id: existing.id,
          alert_roi_change: existing.alert_roi_change ?? true,
          roi_change_threshold: existing.roi_change_threshold ?? 10,
          alert_drawdown: existing.alert_drawdown ?? true,
          drawdown_threshold: existing.drawdown_threshold ?? 20,
          alert_score_change: existing.alert_score_change ?? false,
          score_change_threshold: existing.score_change_threshold ?? 5,
          alert_rank_change: existing.alert_rank_change ?? false,
          rank_change_threshold: existing.rank_change_threshold ?? 5,
          one_time: existing.one_time ?? false,
          enabled: existing.enabled ?? true,
        })
        if (existing.id) {
          const histRes = await fetch(`/api/alerts?alert_id=${existing.id}&limit=20`, {
            headers: authHeaders(),
            signal: AbortSignal.timeout(15_000),
          })
          const histData = await histRes.json().catch(() => null)
          if (histRes.status === 403) {
            setForbidden(true)
            return
          }
          if (!histRes.ok || !Array.isArray(histData?.data?.history)) {
            throw new Error(
              typeof histData?.error === 'string' && histData.error.trim()
                ? histData.error.trim()
                : t('adminLoadFailed')
            )
          }
          setHistory(histData.data.history)
        }
      }
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : t('adminLoadFailed')
      setLoadError(message)
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }, [traderId, source, accessToken, authHeaders, showToast, t])

  useEffect(() => {
    if (userId) fetchAlert()
    else setLoading(false)
  }, [userId, fetchAlert])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/trader-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(), ...getCsrfHeaders() },
        body: JSON.stringify({ trader_id: traderId, source, ...alert }),
      })
      const data = await res.json()
      if (res.ok) {
        showToast(t('alertEnabled'), 'success')
        if (data.data?.alert?.id) {
          setAlert((prev) => ({ ...prev, id: data.data.alert.id }))
        }
      } else {
        showToast(data.error || t('saveFailed2'), 'error')
      }
    } catch {
      showToast(t('saveFailed2'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!alert.id) return
    try {
      const res = await fetch(`/api/trader-alerts?id=${alert.id}`, {
        method: 'DELETE',
        headers: { ...authHeaders(), ...getCsrfHeaders() },
      })
      if (res.ok) {
        setAlert(DEFAULT_ALERT)
        setHistory([])
        showToast(t('alertDisabled'), 'success')
      }
    } catch {
      showToast(t('saveFailed2'), 'error')
    }
  }

  const handleToggle = async () => {
    if (!alert.id || toggleInFlightRef.current) return

    toggleInFlightRef.current = true
    setToggling(true)
    const previousEnabled = alert.enabled
    const newEnabled = !alert.enabled
    setAlert((prev) => ({ ...prev, enabled: newEnabled }))

    try {
      const res = await fetch('/api/trader-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(), ...getCsrfHeaders() },
        body: JSON.stringify({ trader_id: traderId, source, ...alert, enabled: newEnabled }),
      })

      let data: AlertMutationResponse | null = null
      try {
        data = (await res.json()) as AlertMutationResponse
      } catch {
        // A proxy may return an HTML error page. The status still decides failure.
      }

      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string' && data.error.trim()
            ? data.error.trim()
            : t('saveFailed2')
        )
      }
      if (data?.data?.alert?.enabled !== newEnabled) {
        throw new Error(t('saveFailed2'))
      }

      showToast(newEnabled ? t('alertEnabled') : t('alertDisabled'), 'success')
    } catch (error) {
      setAlert((prev) => ({ ...prev, enabled: previousEnabled }))
      showToast(error instanceof Error && error.message ? error.message : t('saveFailed2'), 'error')
    } finally {
      toggleInFlightRef.current = false
      setToggling(false)
    }
  }

  // Loading / auth gates
  if (!userId) {
    return (
      <Box style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.colors.text.secondary }}>{t('loginRequired')}</Text>
      </Box>
    )
  }

  if (loading) {
    return (
      <Box style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.colors.text.secondary }}>{t('loading')}</Text>
      </Box>
    )
  }

  if (forbidden) {
    return (
      <EmptyState
        variant="card"
        title={t('traderAlertsProRequired')}
        description={t('pricingProAlerts')}
        action={
          <Link
            href="/pricing"
            className="tap-target"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.md,
              background: tokens.colors.accent.primary,
              color: tokens.colors.white,
              fontWeight: tokens.typography.fontWeight.bold,
              textDecoration: 'none',
            }}
          >
            {t('upgrade')}
          </Link>
        }
      />
    )
  }

  if (loadError) {
    return (
      <Box style={{ padding: tokens.spacing[4] }}>
        <ErrorMessage
          message={loadError}
          onRetry={accessToken ? () => void fetchAlert() : undefined}
        />
      </Box>
    )
  }

  const alertTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      roi_change: t('alertRoiChangeLabel'),
      drawdown: t('alertDrawdownLabel'),
      score_change: 'Arena Score',
      rank_change: t('alertRankChangeLabel'),
    }
    return labels[type] || type
  }

  return (
    <Box
      style={{
        padding: 16,
        borderRadius: tokens.radius.lg,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <Text style={{ fontWeight: 600, fontSize: 16 }}>
          {t('alertSettings')} - {traderHandle}
        </Text>
        <Box style={{ display: 'flex', gap: 8 }}>
          {alert.id && (
            <Button
              onClick={handleToggle}
              disabled={toggling || saving}
              aria-busy={toggling}
              style={{
                padding: '4px 12px',
                fontSize: 13,
                borderRadius: tokens.radius.sm,
                background: alert.enabled
                  ? tokens.colors.accent.success
                  : tokens.colors.bg.tertiary,
                color: alert.enabled ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                border: 'none',
                cursor: toggling || saving ? 'not-allowed' : 'pointer',
                opacity: toggling || saving ? 0.6 : 1,
              }}
            >
              {alert.enabled ? t('alertEnabled') : t('alertDisabled')}
            </Button>
          )}
          {onClose && (
            <Button
              onClick={onClose}
              style={{
                padding: '4px 8px',
                fontSize: 13,
                borderRadius: tokens.radius.sm,
                background: 'transparent',
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
              }}
            >
              X
            </Button>
          )}
        </Box>
      </Box>

      <Text
        style={{
          marginBottom: 12,
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.tertiary,
        }}
      >
        {t('alertCheckCadence')}
      </Text>

      {/* Alert rows */}
      <AlertRow
        label={t('alertRoiChangeLabel')}
        desc={t('alertRoiChangeDesc')}
        checked={alert.alert_roi_change}
        onToggle={() => setAlert((prev) => ({ ...prev, alert_roi_change: !prev.alert_roi_change }))}
        threshold={alert.roi_change_threshold}
        onThresholdChange={(v) => setAlert((prev) => ({ ...prev, roi_change_threshold: v }))}
        unit="%"
      />
      <AlertRow
        label={t('alertDrawdownLabel')}
        desc={t('alertDrawdownDesc')}
        checked={alert.alert_drawdown}
        onToggle={() => setAlert((prev) => ({ ...prev, alert_drawdown: !prev.alert_drawdown }))}
        threshold={alert.drawdown_threshold}
        onThresholdChange={(v) => setAlert((prev) => ({ ...prev, drawdown_threshold: v }))}
        unit="%"
      />
      <AlertRow
        label={t('alertRankChangeLabel')}
        desc={t('alertRankChangeDesc')}
        checked={alert.alert_rank_change}
        onToggle={() =>
          setAlert((prev) => ({ ...prev, alert_rank_change: !prev.alert_rank_change }))
        }
        threshold={alert.rank_change_threshold}
        onThresholdChange={(v) => setAlert((prev) => ({ ...prev, rank_change_threshold: v }))}
        unit={t('alertRankUnit')}
      />
      <AlertRow
        label={t('alertScoreChangeLabel')}
        desc={t('alertScoreChangeDesc')}
        checked={alert.alert_score_change}
        onToggle={() =>
          setAlert((prev) => ({ ...prev, alert_score_change: !prev.alert_score_change }))
        }
        threshold={alert.score_change_threshold}
        onThresholdChange={(v) => setAlert((prev) => ({ ...prev, score_change_threshold: v }))}
        unit={t('alertScoreUnit')}
      />
      {/* One-time toggle */}
      <Box
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 16 }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={alert.one_time}
            onChange={() => setAlert((prev) => ({ ...prev, one_time: !prev.one_time }))}
          />
          <Text style={{ fontSize: 13, color: tokens.colors.text.secondary }}>
            {t('alertOneTime')}
          </Text>
        </label>
      </Box>

      {/* Action buttons */}
      <Box style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button
          onClick={handleSave}
          disabled={saving}
          style={{
            flex: 1,
            padding: '8px 16px',
            borderRadius: tokens.radius.md,
            background: tokens.colors.accent.primary,
            color: 'var(--color-on-accent)',
            border: 'none',
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1,
            fontWeight: 600,
          }}
        >
          {saving ? `\u23F3 ${t('saving')}` : t('save')}
        </Button>
        {alert.id && (
          <Button
            onClick={handleDelete}
            style={{
              padding: '8px 16px',
              borderRadius: tokens.radius.md,
              background: 'transparent',
              color: tokens.colors.accent.error,
              border: `1px solid ${tokens.colors.accent.error}`,
              cursor: 'pointer',
            }}
          >
            {t('delete')}
          </Button>
        )}
      </Box>

      {/* Alert history */}
      {alert.id && <AlertHistory history={history} alertTypeLabel={alertTypeLabel} />}
    </Box>
  )
}

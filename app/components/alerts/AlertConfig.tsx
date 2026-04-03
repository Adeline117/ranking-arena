'use client'

import { useState, useEffect, useCallback } from 'react'
import { Box, Text, Button } from '../base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

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
  alert_price_above: boolean
  price_above_value: number | null
  alert_price_below: boolean
  price_below_value: number | null
  price_symbol: string | null
  one_time: boolean
  enabled: boolean
}

interface HistoryItem {
  id: string
  alert_type: string
  triggered_at: string
  data: Record<string, unknown>
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
  alert_price_above: false,
  price_above_value: null,
  alert_price_below: false,
  price_below_value: null,
  price_symbol: null,
  one_time: false,
  enabled: true,
}

export default function AlertConfig({ traderId, traderHandle, source, userId, onClose }: AlertConfigProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [alert, setAlert] = useState<AlertData>(DEFAULT_ALERT)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const fetchAlert = useCallback(async () => {
    try {
      const res = await fetch(`/api/trader-alerts?trader_id=${encodeURIComponent(traderId)}`)
      const data = await res.json()
      if (data.data?.alerts?.length > 0) {
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
          alert_price_above: existing.alert_price_above ?? false,
          price_above_value: existing.price_above_value ?? null,
          alert_price_below: existing.alert_price_below ?? false,
          price_below_value: existing.price_below_value ?? null,
          price_symbol: existing.price_symbol ?? null,
          one_time: existing.one_time ?? false,
          enabled: existing.enabled ?? true,
        })

        // Fetch history for this alert
        if (existing.id) {
          const histRes = await fetch(`/api/alerts?alert_id=${existing.id}&limit=20`)
          const histData = await histRes.json()
          if (histData.data?.history) {
            setHistory(histData.data.history)
          }
        }
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [traderId])

  useEffect(() => {
    if (userId) fetchAlert()
    else setLoading(false)
  }, [userId, fetchAlert])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/trader-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trader_id: traderId,
          source,
          ...alert,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        showToast(t('alertEnabled'), 'success')
        if (data.data?.alert?.id) {
          setAlert(prev => ({ ...prev, id: data.data.alert.id }))
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
      const res = await fetch(`/api/trader-alerts?id=${alert.id}`, { method: 'DELETE' })
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
    const newEnabled = !alert.enabled
    setAlert(prev => ({ ...prev, enabled: newEnabled }))
    if (alert.id) {
      await fetch('/api/trader-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trader_id: traderId,
          source,
          ...alert,
          enabled: newEnabled,
        }),
      })
      showToast(newEnabled ? t('alertEnabled') : t('alertDisabled'), 'success')
    }
  }

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

  const alertTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      roi_change: t('alertRoiChangeLabel'),
      drawdown: t('alertDrawdownLabel'),
      score_change: 'Arena Score',
      rank_change: t('alertRankChangeLabel'),
      price_above: t('alertPriceAboveLabel'),
      price_below: t('alertPriceBelowLabel'),
    }
    return labels[type] || type
  }

  return (
    <Box style={{
      padding: 16,
      borderRadius: tokens.radius.lg,
      background: tokens.colors.bg.secondary,
      border: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontWeight: 600, fontSize: 16 }}>
          {t('alertSettings')} - {traderHandle}
        </Text>
        <Box style={{ display: 'flex', gap: 8 }}>
          {alert.id && (
            <Button
              onClick={handleToggle}
              style={{
                padding: '4px 12px',
                fontSize: 13,
                borderRadius: tokens.radius.sm,
                background: alert.enabled ? tokens.colors.accent.success : tokens.colors.bg.tertiary,
                color: alert.enabled ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {alert.enabled ? t('alertEnabled') : t('alertDisabled')}
            </Button>
          )}
          {onClose && (
            <Button onClick={onClose} style={{
              padding: '4px 8px', fontSize: 13, borderRadius: tokens.radius.sm,
              background: 'transparent', border: `1px solid ${tokens.colors.border.primary}`,
              color: tokens.colors.text.secondary, cursor: 'pointer',
            }}>
              X
            </Button>
          )}
        </Box>
      </Box>

      {/* ROI 变化 */}
      <AlertRow
        label={t('alertRoiChangeLabel')}
        desc={t('alertRoiChangeDesc')}
        checked={alert.alert_roi_change}
        onToggle={() => setAlert(prev => ({ ...prev, alert_roi_change: !prev.alert_roi_change }))}
        threshold={alert.roi_change_threshold}
        onThresholdChange={(v) => setAlert(prev => ({ ...prev, roi_change_threshold: v }))}
        unit="%"
      />

      {/* 回撤警告 */}
      <AlertRow
        label={t('alertDrawdownLabel')}
        desc={t('alertDrawdownDesc')}
        checked={alert.alert_drawdown}
        onToggle={() => setAlert(prev => ({ ...prev, alert_drawdown: !prev.alert_drawdown }))}
        threshold={alert.drawdown_threshold}
        onThresholdChange={(v) => setAlert(prev => ({ ...prev, drawdown_threshold: v }))}
        unit="%"
      />

      {/* 排名变化 */}
      <AlertRow
        label={t('alertRankChangeLabel')}
        desc={t('alertRankChangeDesc')}
        checked={alert.alert_rank_change}
        onToggle={() => setAlert(prev => ({ ...prev, alert_rank_change: !prev.alert_rank_change }))}
        threshold={alert.rank_change_threshold}
        onThresholdChange={(v) => setAlert(prev => ({ ...prev, rank_change_threshold: v }))}
        unit={t('alertRankUnit')}
      />

      {/* 价格上破 */}
      <AlertPriceRow
        label={t('alertPriceAboveLabel')}
        desc={t('alertPriceAboveDesc')}
        checked={alert.alert_price_above}
        onToggle={() => setAlert(prev => ({ ...prev, alert_price_above: !prev.alert_price_above }))}
        value={alert.price_above_value}
        onValueChange={(v) => setAlert(prev => ({ ...prev, price_above_value: v }))}
        symbol={alert.price_symbol}
        onSymbolChange={(v) => setAlert(prev => ({ ...prev, price_symbol: v }))}
      />

      {/* 价格下破 */}
      <AlertPriceRow
        label={t('alertPriceBelowLabel')}
        desc={t('alertPriceBelowDesc')}
        checked={alert.alert_price_below}
        onToggle={() => setAlert(prev => ({ ...prev, alert_price_below: !prev.alert_price_below }))}
        value={alert.price_below_value}
        onValueChange={(v) => setAlert(prev => ({ ...prev, price_below_value: v }))}
        symbol={alert.price_symbol}
        onSymbolChange={(v) => setAlert(prev => ({ ...prev, price_symbol: v }))}
      />

      {/* 一次性提醒 */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={alert.one_time}
            onChange={() => setAlert(prev => ({ ...prev, one_time: !prev.one_time }))}
          />
          <Text style={{ fontSize: 13, color: tokens.colors.text.secondary }}>
            {t('alertOneTime')}
          </Text>
        </label>
      </Box>

      {/* 操作按钮 */}
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
          {saving ? `⏳ ${t('saving')}` : t('save')}
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

      {/* 提醒历史 */}
      {alert.id && history.length > 0 && (
        <Box>
          <Button
            onClick={() => setShowHistory(!showHistory)}
            style={{
              background: 'transparent',
              border: 'none',
              color: tokens.colors.accent.primary,
              cursor: 'pointer',
              fontSize: 13,
              padding: 0,
            }}
          >
            {t('alertHistory')} ({history.length})
          </Button>
          {showHistory && (
            <Box style={{ marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
              {history.map(item => (
                <Box key={item.id} style={{
                  padding: '6px 0',
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  fontSize: 12,
                }}>
                  <Text style={{ color: tokens.colors.text.secondary }}>
                    {new Date(item.triggered_at).toLocaleString('zh-CN')}
                  </Text>
                  <Text style={{ color: tokens.colors.text.primary, marginLeft: 8 }}>
                    [{alertTypeLabel(item.alert_type)}] {(item.data as { message?: string })?.message || ''}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

// --- Sub-components ---

function AlertRow({
  label, desc, checked, onToggle, threshold, onThresholdChange, unit,
}: {
  label: string
  desc: string
  checked: boolean
  onToggle: () => void
  threshold: number
  onThresholdChange: (v: number) => void
  unit: string
}) {
  return (
    <Box style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={label} />
        <Box>
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{label}</Text>
          <Text style={{ fontSize: 12, color: tokens.colors.text.secondary }}>{desc}</Text>
        </Box>
      </Box>
      {checked && (
        <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            value={threshold}
            onChange={(e) => onThresholdChange(Number(e.target.value))}
            aria-label={`${label} threshold`}
            style={{
              width: 60, padding: '4px 6px', borderRadius: tokens.radius.sm, fontSize: 13,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              textAlign: 'right',
            }}
          />
          <Text style={{ fontSize: 12, color: tokens.colors.text.secondary }}>{unit}</Text>
        </Box>
      )}
    </Box>
  )
}

function AlertPriceRow({
  label, desc, checked, onToggle, value, onValueChange, symbol, onSymbolChange,
}: {
  label: string
  desc: string
  checked: boolean
  onToggle: () => void
  value: number | null
  onValueChange: (v: number | null) => void
  symbol: string | null
  onSymbolChange: (v: string | null) => void
}) {
  return (
    <Box style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={label} />
        <Box>
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{label}</Text>
          <Text style={{ fontSize: 12, color: tokens.colors.text.secondary }}>{desc}</Text>
        </Box>
      </Box>
      {checked && (
        <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="text"
            placeholder="BTC"
            value={symbol || ''}
            onChange={(e) => onSymbolChange(e.target.value || null)}
            aria-label={`${label} symbol`}
            style={{
              width: 50, padding: '4px 6px', borderRadius: tokens.radius.sm, fontSize: 13,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
            }}
          />
          <input
            type="number"
            placeholder="0"
            value={value ?? ''}
            onChange={(e) => onValueChange(e.target.value ? Number(e.target.value) : null)}
            aria-label={`${label} value`}
            style={{
              width: 80, padding: '4px 6px', borderRadius: tokens.radius.sm, fontSize: 13,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              textAlign: 'right',
            }}
          />
          <Text style={{ fontSize: 12, color: tokens.colors.text.secondary }}>USD</Text>
        </Box>
      )}
    </Box>
  )
}

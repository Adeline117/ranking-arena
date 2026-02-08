'use client'

import { useState, useEffect } from 'react'
import { Box, Text, Button } from '../base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface AlertItem {
  id: string
  trader_id: string
  source?: string
  enabled: boolean
  alert_roi_change: boolean
  roi_change_threshold: number
  alert_drawdown: boolean
  drawdown_threshold: number
  alert_rank_change: boolean
  rank_change_threshold: number
  alert_price_above: boolean
  price_above_value: number | null
  alert_price_below: boolean
  price_below_value: number | null
  price_symbol: string | null
  last_triggered_at: string | null
  created_at: string
}

interface AlertListProps {
  userId: string
  onSelectAlert?: (traderId: string) => void
}

export default function AlertList({ userId, onSelectAlert }: AlertListProps) {
  const { t } = useLanguage()
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) return
    fetch('/api/trader-alerts')
      .then(res => res.json())
      .then(data => {
        if (data.data?.alerts) setAlerts(data.data.alerts)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [userId])

  const handleToggle = async (alert: AlertItem) => {
    const newEnabled = !alert.enabled
    setAlerts(prev => prev.map(a => a.id === alert.id ? { ...a, enabled: newEnabled } : a))
    await fetch('/api/trader-alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trader_id: alert.trader_id, source: alert.source, enabled: newEnabled }),
    })
  }

  const handleDelete = async (alertId: string) => {
    setAlerts(prev => prev.filter(a => a.id !== alertId))
    await fetch(`/api/trader-alerts?id=${alertId}`, { method: 'DELETE' })
  }

  if (loading) {
    return (
      <Box style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.colors.text.secondary }}>{t('loading')}</Text>
      </Box>
    )
  }

  if (alerts.length === 0) {
    return (
      <Box style={{ padding: 24, textAlign: 'center' }}>
        <Text style={{ color: tokens.colors.text.secondary }}>{t('alertNoAlerts')}</Text>
      </Box>
    )
  }

  const getActiveTypes = (alert: AlertItem): string[] => {
    const types: string[] = []
    if (alert.alert_roi_change) types.push(`ROI >${alert.roi_change_threshold}%`)
    if (alert.alert_drawdown) types.push(`MDD >${alert.drawdown_threshold}%`)
    if (alert.alert_rank_change) types.push(`${t('alertRankChangeLabel')} >${alert.rank_change_threshold}`)
    if (alert.alert_price_above && alert.price_above_value != null) {
      types.push(`${alert.price_symbol || ''} >${alert.price_above_value}`)
    }
    if (alert.alert_price_below && alert.price_below_value != null) {
      types.push(`${alert.price_symbol || ''} <${alert.price_below_value}`)
    }
    return types
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {alerts.map(alert => (
        <Box
          key={alert.id}
          style={{
            padding: 12,
            borderRadius: 8,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            opacity: alert.enabled ? 1 : 0.6,
            cursor: 'pointer',
          }}
          onClick={() => onSelectAlert?.(alert.trader_id)}
        >
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontWeight: 600, fontSize: 14 }}>{alert.trader_id}</Text>
            <Box style={{ display: 'flex', gap: 6 }}>
              <Button
                onClick={(e) => { e.stopPropagation(); handleToggle(alert) }}
                style={{
                  padding: '2px 8px', fontSize: 12, borderRadius: 4, border: 'none', cursor: 'pointer',
                  background: alert.enabled ? tokens.colors.accent.success : tokens.colors.bg.tertiary,
                  color: alert.enabled ? '#fff' : tokens.colors.text.secondary,
                }}
              >
                {alert.enabled ? t('alertEnabled') : t('alertDisabled')}
              </Button>
              <Button
                onClick={(e) => { e.stopPropagation(); handleDelete(alert.id) }}
                style={{
                  padding: '2px 8px', fontSize: 12, borderRadius: 4, border: 'none', cursor: 'pointer',
                  background: tokens.colors.bg.tertiary,
                  color: tokens.colors.accent.error,
                }}
              >
                {t('delete')}
              </Button>
            </Box>
          </Box>
          <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            {getActiveTypes(alert).map((type, i) => (
              <Text key={i} style={{
                fontSize: 11, padding: '1px 6px', borderRadius: 4,
                background: tokens.colors.bg.tertiary,
                color: tokens.colors.text.secondary,
              }}>
                {type}
              </Text>
            ))}
          </Box>
          {alert.last_triggered_at && (
            <Text style={{ fontSize: 11, color: tokens.colors.text.tertiary, marginTop: 4 }}>
              {t('alertLastTriggered')}: {new Date(alert.last_triggered_at).toLocaleString('zh-CN')}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}

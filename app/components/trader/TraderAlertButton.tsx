'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useTraderAlerts, TraderAlert } from '@/lib/hooks/useTraderAlerts'

interface TraderAlertButtonProps {
  traderId: string
  platform: string
  traderName: string
}

export default function TraderAlertButton({ traderId, platform, traderName }: TraderAlertButtonProps) {
  const { language } = useLanguage()
  const { alerts, addAlert, removeAlert, hasAlert, getAlertsForTrader } = useTraderAlerts()
  const [showModal, setShowModal] = useState(false)
  const [alertType, setAlertType] = useState<TraderAlert['alertType']>('roi_change')
  const [threshold, setThreshold] = useState(10)

  const traderAlerts = getAlertsForTrader(traderId, platform)
  const isWatched = hasAlert(traderId, platform)

  const handleAddAlert = () => {
    addAlert({
      traderId,
      platform,
      traderName,
      alertType,
      threshold,
      enabled: true,
    })
    setShowModal(false)
  }

  const handleRemoveAll = () => {
    traderAlerts.forEach(a => removeAlert(a.id))
  }

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${isWatched ? tokens.colors.accent.warning : tokens.colors.border.primary}`,
          background: isWatched ? `${tokens.colors.accent.warning}15` : tokens.colors.bg.secondary,
          color: isWatched ? tokens.colors.accent.warning : tokens.colors.text.secondary,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: 500,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill={isWatched ? tokens.colors.accent.warning : 'none'} stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {isWatched 
          ? (language === 'zh' ? `${traderAlerts.length} 个提醒` : `${traderAlerts.length} Alert${traderAlerts.length > 1 ? 's' : ''}`)
          : (language === 'zh' ? '设置提醒' : 'Set Alert')
        }
      </button>

      {/* Alert Modal */}
      {showModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: tokens.colors.bg.primary,
              borderRadius: tokens.radius.xl,
              padding: tokens.spacing[6],
              width: '90%',
              maxWidth: 400,
              border: `1px solid ${tokens.colors.border.primary}`,
              boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
            }}
          >
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
              {language === 'zh' ? '交易员提醒设置' : 'Trader Alert Settings'}
            </Text>
            
            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
              {traderName}
            </Text>

            {/* Existing Alerts */}
            {traderAlerts.length > 0 && (
              <Box style={{ marginBottom: tokens.spacing[4] }}>
                <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                  {language === 'zh' ? '已设置的提醒' : 'Existing Alerts'}
                </Text>
                {traderAlerts.map(alert => (
                  <Box
                    key={alert.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: tokens.spacing[2],
                      background: tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.md,
                      marginBottom: tokens.spacing[1],
                    }}
                  >
                    <Text size="sm">
                      {alert.alertType === 'roi_change' && `ROI ${alert.threshold > 0 ? '>' : '<'} ${alert.threshold}%`}
                      {alert.alertType === 'rank_change' && `Rank ${language === 'zh' ? '变化' : 'change'} > ${alert.threshold}`}
                      {alert.alertType === 'drawdown' && `DD > ${alert.threshold}%`}
                    </Text>
                    <button
                      onClick={() => removeAlert(alert.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: tokens.colors.accent.error,
                        cursor: 'pointer',
                        padding: tokens.spacing[1],
                      }}
                    >
                      ✕
                    </button>
                  </Box>
                ))}
              </Box>
            )}

            {/* Add New Alert */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
                {language === 'zh' ? '添加新提醒' : 'Add New Alert'}
              </Text>
              
              <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                {(['roi_change', 'rank_change', 'drawdown'] as const).map(type => (
                  <button
                    key={type}
                    onClick={() => setAlertType(type)}
                    style={{
                      flex: 1,
                      padding: tokens.spacing[2],
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${alertType === type ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                      background: alertType === type ? `${tokens.colors.accent.primary}15` : 'transparent',
                      color: alertType === type ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.xs,
                    }}
                  >
                    {type === 'roi_change' && 'ROI'}
                    {type === 'rank_change' && (language === 'zh' ? '排名' : 'Rank')}
                    {type === 'drawdown' && 'DD'}
                  </button>
                ))}
              </Box>

              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                <Text size="sm" color="secondary">
                  {language === 'zh' ? '阈值:' : 'Threshold:'}
                </Text>
                <input
                  type="number"
                  value={threshold}
                  onChange={e => setThreshold(Number(e.target.value))}
                  style={{
                    width: 80,
                    padding: tokens.spacing[2],
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                />
                <Text size="sm" color="secondary">
                  {alertType === 'rank_change' ? (language === 'zh' ? '位' : 'places') : '%'}
                </Text>
              </Box>
            </Box>

            {/* Actions */}
            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              <Button
                variant="secondary"
                onClick={() => setShowModal(false)}
                style={{ flex: 1 }}
              >
                {language === 'zh' ? '取消' : 'Cancel'}
              </Button>
              <Button
                variant="primary"
                onClick={handleAddAlert}
                style={{ flex: 1 }}
              >
                {language === 'zh' ? '添加提醒' : 'Add Alert'}
              </Button>
            </Box>
          </div>
        </div>
      )}
    </>
  )
}

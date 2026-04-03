'use client'

import React, { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import PremiumGate, { ProLabel } from '../premium/PremiumGate'

// Icons
const BellIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
  </svg>
)

const BellOffIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M13.73 21a2 2 0 01-3.46 0M18.63 13A17.89 17.89 0 0118 8M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14M18 8a6 6 0 00-9.33-5M1 1l22 22" />
  </svg>
)

const TrendUpIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M23 6l-9.5 9.5-5-5L1 18" />
    <path d="M17 6h6v6" />
  </svg>
)

const TrendDownIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M23 18l-9.5-9.5-5 5L1 6" />
    <path d="M17 18h6v-6" />
  </svg>
)

const HashIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="4" y1="9" x2="20" y2="9" />
    <line x1="4" y1="15" x2="20" y2="15" />
    <line x1="10" y1="3" x2="8" y2="21" />
    <line x1="16" y1="3" x2="14" y2="21" />
  </svg>
)

const MailIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
)

const SmartphoneIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
    <line x1="12" y1="18" x2="12.01" y2="18" />
  </svg>
)

const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const TrashIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3,6 5,6 21,6" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
)

type AlertType = 'roi_change' | 'drawdown' | 'rank_change'
type Operator = '>' | '<' | '>=' | '<=' | 'change_by'
type AlertChannel = 'email' | 'push'

interface AlertCondition {
  id: string
  type: AlertType
  operator: Operator
  threshold: number
  isPercent: boolean
  channels: AlertChannel[]
  isActive: boolean
}

interface AdvancedAlertsProps {
  isPro: boolean
  isLoggedIn?: boolean
  traderId?: string
  traderHandle?: string
  /** Existing alert conditions */
  existingConditions?: AlertCondition[]
  /** Callback when conditions change */
  onConditionsChange?: (conditions: AlertCondition[]) => void
}

/**
 * Advanced Alerts Configuration Component (Pro Only)
 * Allows Pro users to set up custom alert conditions
 */
export default function AdvancedAlerts({
  isPro,
  isLoggedIn = true,
  traderId: _traderId,
  traderHandle,
  existingConditions = [],
  onConditionsChange,
}: AdvancedAlertsProps) {
  const { t } = useLanguage()

  // Demo conditions if none provided
  const [conditions, setConditions] = useState<AlertCondition[]>(
    existingConditions.length > 0
      ? existingConditions
      : [
          {
            id: '1',
            type: 'roi_change',
            operator: 'change_by',
            threshold: 10,
            isPercent: true,
            channels: ['push'],
            isActive: true,
          },
          {
            id: '2',
            type: 'drawdown',
            operator: '>',
            threshold: 15,
            isPercent: true,
            channels: ['email', 'push'],
            isActive: true,
          },
        ]
  )

  const [isAddingNew, setIsAddingNew] = useState(false)
  const [newCondition, setNewCondition] = useState<Partial<AlertCondition>>({
    type: 'roi_change',
    operator: 'change_by',
    threshold: 10,
    isPercent: true,
    channels: ['push'],
    isActive: true,
  })

  const alertTypes: { type: AlertType; label: string; icon: React.ReactNode; description: string }[] = [
    {
      type: 'roi_change',
      label: t('alertRoiChangeLabel'),
      icon: <TrendUpIcon size={16} />,
      description: t('alertRoiChangeDesc'),
    },
    {
      type: 'drawdown',
      label: t('alertDrawdownLabel'),
      icon: <TrendDownIcon size={16} />,
      description: t('alertDrawdownDesc'),
    },
    {
      type: 'rank_change',
      label: t('alertRankChangeLabel'),
      icon: <HashIcon size={16} />,
      description: t('alertRankChangeDesc'),
    },
  ]

  const operators: { value: Operator; label: string }[] = [
    { value: '>', label: '>' },
    { value: '<', label: '<' },
    { value: '>=', label: '>=' },
    { value: '<=', label: '<=' },
    { value: 'change_by', label: t('alertChangesBy') },
  ]

  const handleToggleCondition = (id: string) => {
    const updated = conditions.map((c) =>
      c.id === id ? { ...c, isActive: !c.isActive } : c
    )
    setConditions(updated)
    onConditionsChange?.(updated)
  }

  const handleDeleteCondition = (id: string) => {
    const updated = conditions.filter((c) => c.id !== id)
    setConditions(updated)
    onConditionsChange?.(updated)
  }

  const handleAddCondition = () => {
    if (!newCondition.type || newCondition.threshold === undefined) return

    const condition: AlertCondition = {
      id: Date.now().toString(),
      type: newCondition.type as AlertType,
      operator: newCondition.operator as Operator || 'change_by',
      threshold: newCondition.threshold,
      isPercent: newCondition.isPercent ?? true,
      channels: newCondition.channels as AlertChannel[] || ['push'],
      isActive: true,
    }

    const updated = [...conditions, condition]
    setConditions(updated)
    onConditionsChange?.(updated)
    setIsAddingNew(false)
    setNewCondition({
      type: 'roi_change',
      operator: 'change_by',
      threshold: 10,
      isPercent: true,
      channels: ['push'],
      isActive: true,
    })
  }

  const content = (
    <Box>
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: tokens.spacing[4],
          flexWrap: 'wrap',
          gap: tokens.spacing[2],
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <BellIcon size={18} />
          <Text size="md" weight="bold">
            {t('advancedAlerts')}
          </Text>
          <ProLabel size="xs" />
        </Box>
        {traderHandle && (
          <Text size="sm" color="secondary">
            {t('alertMonitoring').replace('{handle}', traderHandle)}
          </Text>
        )}
      </Box>

      {/* Existing Conditions */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
        {conditions.map((condition) => {
          const typeInfo = alertTypes.find((t) => t.type === condition.type)

          return (
            <Box
              key={condition.id}
              style={{
                padding: tokens.spacing[4],
                borderRadius: tokens.radius.lg,
                background: condition.isActive ? tokens.glass.bg.light : tokens.colors.bg.tertiary,
                border: `1px solid ${
                  condition.isActive ? tokens.colors.accent.primary + '30' : tokens.colors.border.primary
                }`,
                opacity: condition.isActive ? 1 : 0.6,
              }}
            >
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: tokens.spacing[3],
                  marginBottom: tokens.spacing[3],
                }}
              >
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <Box
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: tokens.radius.md,
                      background: condition.isActive
                        ? `${tokens.colors.accent.primary}20`
                        : tokens.colors.bg.secondary,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: condition.isActive
                        ? tokens.colors.accent.primary
                        : tokens.colors.text.tertiary,
                    }}
                  >
                    {typeInfo?.icon}
                  </Box>
                  <Box>
                    <Text size="sm" weight="bold">
                      {typeInfo?.label}
                    </Text>
                    <Text size="xs" color="tertiary">
                      {condition.operator === 'change_by'
                        ? `${t('alertChangesByDisplay')} ${condition.threshold}${condition.isPercent ? '%' : ''}`
                        : `${condition.operator} ${condition.threshold}${condition.isPercent ? '%' : ''}`}
                    </Text>
                  </Box>
                </Box>

                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  {/* Channels */}
                  <Box style={{ display: 'flex', gap: 4 }}>
                    {condition.channels.includes('email') && (
                      <Box
                        title={t('alertEmailNotification')}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: tokens.radius.sm,
                          background: tokens.colors.bg.secondary,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: tokens.colors.text.secondary,
                        }}
                      >
                        <MailIcon size={12} />
                      </Box>
                    )}
                    {condition.channels.includes('push') && (
                      <Box
                        title={t('alertPushNotification')}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: tokens.radius.sm,
                          background: tokens.colors.bg.secondary,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: tokens.colors.text.secondary,
                        }}
                      >
                        <SmartphoneIcon size={12} />
                      </Box>
                    )}
                  </Box>

                  {/* Toggle */}
                  <button
                    onClick={() => handleToggleCondition(condition.id)}
                    style={{
                      width: 44,
                      height: 24,
                      borderRadius: tokens.radius.full,
                      background: condition.isActive
                        ? tokens.colors.accent.success
                        : tokens.colors.bg.secondary,
                      border: 'none',
                      cursor: 'pointer',
                      position: 'relative',
                      transition: tokens.transition.fast,
                    }}
                  >
                    <Box
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: condition.isActive ? 22 : 2,
                        width: 20,
                        height: 20,
                        borderRadius: tokens.radius.full,
                        background: tokens.colors.white,
                        transition: tokens.transition.fast,
                        boxShadow: tokens.shadow.sm,
                      }}
                    />
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => handleDeleteCondition(condition.id)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: tokens.radius.md,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: tokens.colors.text.tertiary,
                      transition: tokens.transition.fast,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = tokens.colors.accent.error
                      e.currentTarget.style.background = `${tokens.colors.accent.error}15`
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = tokens.colors.text.tertiary
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <TrashIcon size={14} />
                  </button>
                </Box>
              </Box>
            </Box>
          )
        })}

        {conditions.length === 0 && !isAddingNew && (
          <Box
            style={{
              padding: tokens.spacing[6],
              textAlign: 'center',
              color: tokens.colors.text.tertiary,
            }}
          >
            <BellOffIcon size={32} />
            <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
              {t('alertNoConditions')}
            </Text>
          </Box>
        )}
      </Box>

      {/* Add New Condition */}
      {isAddingNew ? (
        <Box
          style={{
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            background: tokens.glass.bg.light,
            border: `1px solid ${tokens.colors.accent.primary}30`,
          }}
        >
          <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            {t('alertAddNewCondition')}
          </Text>

          {/* Alert Type */}
          <Box style={{ marginBottom: tokens.spacing[3] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {t('alertTypeLabel')}
            </Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
              {alertTypes.map((type) => (
                <button
                  key={type.type}
                  onClick={() => setNewCondition({ ...newCondition, type: type.type })}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${
                      newCondition.type === type.type
                        ? tokens.colors.accent.primary
                        : tokens.colors.border.primary
                    }`,
                    background:
                      newCondition.type === type.type
                        ? `${tokens.colors.accent.primary}20`
                        : 'transparent',
                    color:
                      newCondition.type === type.type
                        ? tokens.colors.accent.primary
                        : tokens.colors.text.secondary,
                    cursor: 'pointer',
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  {type.icon}
                  {type.label}
                </button>
              ))}
            </Box>
          </Box>

          {/* Threshold */}
          <Box style={{ marginBottom: tokens.spacing[3] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {t('alertThresholdLabel')}
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <select
                value={newCondition.operator}
                aria-label={t('alertThresholdLabel')}
                onChange={(e) => setNewCondition({ ...newCondition, operator: e.target.value as Operator })}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                {operators.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                value={newCondition.threshold ?? ''}
                aria-label="Threshold value"
                step="any"
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  setNewCondition({ ...newCondition, threshold: !isNaN(v) ? v : 0 })
                }}
                style={{
                  width: 80,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                }}
              />
              <Text size="sm" color="secondary">
                %
              </Text>
            </Box>
          </Box>

          {/* Channels */}
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {t('alertNotificationChannels')}
            </Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              {(['push', 'email'] as AlertChannel[]).map((channel) => {
                const isSelected = newCondition.channels?.includes(channel)
                return (
                  <button
                    key={channel}
                    onClick={() => {
                      const current = newCondition.channels || []
                      const updated = isSelected
                        ? current.filter((c) => c !== channel)
                        : [...current, channel]
                      setNewCondition({ ...newCondition, channels: updated })
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${
                        isSelected ? tokens.colors.accent.primary : tokens.colors.border.primary
                      }`,
                      background: isSelected ? `${tokens.colors.accent.primary}20` : 'transparent',
                      color: isSelected ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.sm,
                    }}
                  >
                    {channel === 'email' ? <MailIcon size={14} /> : <SmartphoneIcon size={14} />}
                    {channel === 'email' ? t('alertEmailChannel') : t('alertPushChannel')}
                  </button>
                )
              })}
            </Box>
          </Box>

          {/* Actions */}
          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            <button
              onClick={() => setIsAddingNew(false)}
              style={{
                flex: 1,
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: 'transparent',
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 500,
              }}
            >
              {t('cancel')}
            </button>
            <button
              onClick={handleAddCondition}
              style={{
                flex: 1,
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: tokens.gradient.primary,
                color: tokens.colors.white,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 600,
              }}
            >
              {t('save')}
            </button>
          </Box>
        </Box>
      ) : (
        <button
          onClick={() => setIsAddingNew(true)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderRadius: tokens.radius.lg,
            border: `1px dashed ${tokens.colors.border.primary}`,
            background: 'transparent',
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 500,
            transition: tokens.transition.fast,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = tokens.colors.accent.primary
            e.currentTarget.style.color = tokens.colors.accent.primary
            e.currentTarget.style.background = `${tokens.colors.accent.primary}10`
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = tokens.colors.border.primary
            e.currentTarget.style.color = tokens.colors.text.secondary
            e.currentTarget.style.background = 'transparent'
          }}
        >
          <PlusIcon size={16} />
          {t('alertAddCondition')}
        </button>
      )}
    </Box>
  )

  return (
    <PremiumGate
      isPro={isPro}
      isLoggedIn={isLoggedIn}
      featureName={t('advancedAlerts')}
      blurAmount={10}
      minHeight={300}
    >
      {content}
    </PremiumGate>
  )
}

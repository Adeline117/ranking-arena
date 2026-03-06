'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { MailIcon, SmartphoneIcon, TrashIcon } from './AlertIcons'
import type { AlertCondition, AlertTypeInfo } from './alert-types'

interface AlertConditionCardProps {
  condition: AlertCondition
  alertTypes: AlertTypeInfo[]
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

export default function AlertConditionCard({
  condition,
  alertTypes,
  onToggle,
  onDelete,
}: AlertConditionCardProps) {
  const { t } = useLanguage()
  const typeInfo = alertTypes.find((at) => at.type === condition.type)

  return (
    <Box
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
            onClick={() => onToggle(condition.id)}
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
            onClick={() => onDelete(condition.id)}
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
}

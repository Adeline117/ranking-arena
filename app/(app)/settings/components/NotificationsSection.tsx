'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { SectionCard, ToggleSwitch, RadioOption } from './shared'
import { isHapticSupported, haptic, setHapticsEnabled } from '@/lib/utils/haptics'
import { PushNotificationToggle } from '@/app/components/notifications/PushNotificationToggle'
import { logger } from '@/lib/logger'
import type { NotificationPreferenceField } from '@/lib/profile/notification-preferences'

interface NotificationsSectionProps {
  notifyFollow: boolean
  setNotifyFollow: (v: boolean) => void
  notifyLike: boolean
  setNotifyLike: (v: boolean) => void
  notifyComment: boolean
  setNotifyComment: (v: boolean) => void
  notifyMention: boolean
  setNotifyMention: (v: boolean) => void
  notifyMessage: boolean
  setNotifyMessage: (v: boolean) => void
  notifyTraderEvents: boolean
  setNotifyTraderEvents: (v: boolean) => void
  hapticEnabled: boolean
  setHapticEnabled: (v: boolean) => void
  emailDigest: 'none' | 'daily' | 'weekly'
  onEmailDigestChange: (v: 'none' | 'daily' | 'weekly') => void
  onToast?: (message: string, type: 'success' | 'error') => void
  onToggleSave?: (
    field: NotificationPreferenceField,
    value: boolean,
    previousValue: boolean,
    setter: (value: boolean) => void
  ) => void
}

export const NotificationsSection = React.memo(function NotificationsSection(
  props: NotificationsSectionProps
) {
  const { t } = useLanguage()
  const onToast =
    props.onToast ||
    ((msg: string) => {
      logger.warn(msg)
    })

  const items = [
    {
      key: 'follow',
      field: 'notify_follow' as const,
      labelKey: 'newFollowerNotify',
      value: props.notifyFollow,
      setter: props.setNotifyFollow,
    },
    {
      key: 'like',
      field: 'notify_like' as const,
      labelKey: 'postLikedNotify',
      value: props.notifyLike,
      setter: props.setNotifyLike,
    },
    {
      key: 'comment',
      field: 'notify_comment' as const,
      labelKey: 'postCommentedNotify',
      value: props.notifyComment,
      setter: props.setNotifyComment,
    },
    {
      key: 'mention',
      field: 'notify_mention' as const,
      labelKey: 'mentionedNotify',
      value: props.notifyMention,
      setter: props.setNotifyMention,
    },
    {
      key: 'message',
      field: 'notify_message' as const,
      labelKey: 'newMessageNotify',
      value: props.notifyMessage,
      setter: props.setNotifyMessage,
    },
    {
      key: 'trader_events',
      field: 'notify_trader_events' as const,
      labelKey: 'traderEventsNotify',
      value: props.notifyTraderEvents,
      setter: props.setNotifyTraderEvents,
    },
  ]

  return (
    <SectionCard
      id="notifications"
      title={t('notificationsSection')}
      description={t('notifications')}
    >
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
        {items.map((item) => (
          <Box
            key={item.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <Box>
              <Text size="sm" weight="medium">
                {t(item.labelKey as keyof typeof import('@/lib/i18n').translations.zh)}
              </Text>
            </Box>
            <ToggleSwitch
              ariaLabel={t(item.labelKey as keyof typeof import('@/lib/i18n').translations.zh)}
              checked={item.value}
              onChange={(v) => {
                item.setter(v)
                props.onToggleSave?.(item.field, v, item.value, item.setter)
              }}
            />
          </Box>
        ))}
      </Box>

      {/* Push Notifications */}
      <Box
        style={{
          marginTop: tokens.spacing[5],
          paddingTop: tokens.spacing[5],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('pushNotificationsTitle')}
        </Text>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
          {t('pushNotificationsDesc')}
        </Text>
        <PushNotificationToggle onToast={onToast} />
      </Box>

      {/* Haptic Feedback */}
      {isHapticSupported() && (
        <Box
          style={{
            marginTop: tokens.spacing[5],
            paddingTop: tokens.spacing[5],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {t('hapticFeedbackTitle')}
          </Text>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
            {t('hapticFeedbackDesc')}
          </Text>
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              background: tokens.colors.bg.primary,
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2 8l2 2-2 2" />
                <path d="M22 8l-2 2 2 2" />
                <rect x="6" y="4" width="12" height="16" rx="2" />
              </svg>
              <Text size="sm" weight="medium">
                {t('tradeAlertVibration')}
              </Text>
            </Box>
            <ToggleSwitch
              ariaLabel={t('tradeAlertVibration')}
              checked={props.hapticEnabled}
              onChange={(v) => {
                props.setHapticEnabled(v)
                setHapticsEnabled(v) // 持久化到 localStorage + 更新模块 flag(2026-07-11)
                if (v) haptic('success')
              }}
            />
          </Box>
        </Box>
      )}

      {/* Email Digest */}
      <Box
        style={{
          marginTop: tokens.spacing[5],
          paddingTop: tokens.spacing[5],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('emailDigest')}
        </Text>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
          {t('emailDigestDesc')}
        </Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          <RadioOption
            name="emailDigest"
            value="none"
            currentValue={props.emailDigest}
            label={t('digestNone')}
            description=""
            onChange={props.onEmailDigestChange}
          />
          <RadioOption
            name="emailDigest"
            value="weekly"
            currentValue={props.emailDigest}
            label={t('digestWeekly')}
            description=""
            onChange={props.onEmailDigestChange}
          />
        </Box>
      </Box>
    </SectionCard>
  )
})

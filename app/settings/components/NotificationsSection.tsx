'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { SectionCard, ToggleSwitch, RadioOption } from './shared'
import { isHapticSupported, haptic } from '@/lib/utils/haptics'

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
  hapticEnabled: boolean
  setHapticEnabled: (v: boolean) => void
  emailDigest: 'none' | 'daily' | 'weekly'
  onEmailDigestChange: (v: 'none' | 'daily' | 'weekly') => void
}

export const NotificationsSection = React.memo(function NotificationsSection(props: NotificationsSectionProps) {
  const { t, language } = useLanguage()

  const items = [
    { key: 'follow', labelKey: 'newFollowerNotify', value: props.notifyFollow, setter: props.setNotifyFollow },
    { key: 'like', labelKey: 'postLikedNotify', value: props.notifyLike, setter: props.setNotifyLike },
    { key: 'comment', labelKey: 'postCommentedNotify', value: props.notifyComment, setter: props.setNotifyComment },
    { key: 'mention', labelKey: 'mentionedNotify', value: props.notifyMention, setter: props.setNotifyMention },
    { key: 'message', labelKey: 'newMessageNotify', value: props.notifyMessage, setter: props.setNotifyMessage },
  ]

  return (
    <SectionCard id="notifications" title={t('notificationsSection')} description={t('notifications')}>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
        {items.map(item => (
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
            onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.primary }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <Box>
              <Text size="sm" weight="medium">{t(item.labelKey as keyof typeof import('@/lib/i18n').translations.zh)}</Text>
            </Box>
            <ToggleSwitch checked={item.value} onChange={(v) => item.setter(v)} />
          </Box>
        ))}
      </Box>

      {/* Haptic Feedback */}
      {isHapticSupported() && (
        <Box style={{ marginTop: tokens.spacing[5], paddingTop: tokens.spacing[5], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
          <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {language === 'zh' ? '震动反馈' : 'Haptic Feedback'}
          </Text>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
            {language === 'zh'
              ? '当关注的交易员开仓时，手机会有特定节奏的震动'
              : 'Feel vibrations when followed traders open positions'}
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
              <span style={{ fontSize: 20 }}>V</span>
              <Text size="sm" weight="medium">
                {language === 'zh' ? '交易提醒震动' : 'Trade Alert Vibration'}
              </Text>
            </Box>
            <ToggleSwitch
              checked={props.hapticEnabled}
              onChange={(v) => {
                props.setHapticEnabled(v)
                if (v) haptic('success')
              }}
            />
          </Box>
        </Box>
      )}

      {/* Email Digest */}
      <Box style={{ marginTop: tokens.spacing[5], paddingTop: tokens.spacing[5], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('emailDigest')}
        </Text>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
          {t('emailDigestDesc')}
        </Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          <RadioOption name="emailDigest" value="none" currentValue={props.emailDigest} label={t('digestNone')} description="" onChange={props.onEmailDigestChange} />
          <RadioOption name="emailDigest" value="daily" currentValue={props.emailDigest} label={t('digestDaily')} description="" onChange={props.onEmailDigestChange} />
          <RadioOption name="emailDigest" value="weekly" currentValue={props.emailDigest} label={t('digestWeekly')} description="" onChange={props.onEmailDigestChange} />
        </Box>
      </Box>
    </SectionCard>
  )
})

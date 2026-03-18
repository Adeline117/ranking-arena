'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { SectionCard, ToggleSwitch, RadioOption } from './shared'

interface BlockedUserInfo {
  blockedId: string
  handle: string | null
  avatarUrl: string | null
  createdAt: string
}

interface PrivacySectionProps {
  showFollowers: boolean
  setShowFollowers: (v: boolean) => void
  showFollowing: boolean
  setShowFollowing: (v: boolean) => void
  showProBadge: boolean
  setShowProBadge: (v: boolean) => void
  dmPermission: 'all' | 'mutual' | 'none'
  setDmPermission: (v: 'all' | 'mutual' | 'none') => void
  blockedUsers: BlockedUserInfo[]
  loadingBlockedUsers: boolean
  unblockingId: string | null
  onUnblock: (id: string) => void
}

export const PrivacySection = React.memo(function PrivacySection(props: PrivacySectionProps) {
  const { t } = useLanguage()

  return (
    <SectionCard id="privacy" title={t('privacySection')} description={t('dmPermissions')}>
      {/* Follow lists visibility */}
      <Box style={{ marginBottom: tokens.spacing[5] }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('showFollowerList')}
        </Text>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
          {t('followListVisibilityNote')}
        </Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md }}>
            <Text size="sm" weight="medium">{t('showFollowingListLabel')}</Text>
            <ToggleSwitch checked={props.showFollowing} onChange={(v) => props.setShowFollowing(v)} />
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md }}>
            <Text size="sm" weight="medium">{t('showFollowersListLabel')}</Text>
            <ToggleSwitch checked={props.showFollowers} onChange={(v) => props.setShowFollowers(v)} />
          </Box>
        </Box>
      </Box>

      {/* Pro Badge */}
      <Box style={{ marginBottom: tokens.spacing[5] }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('proBadgeTitle')}
        </Text>
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md }}>
          <Box>
            <Text size="sm" weight="medium">{t('showProBadgeLabel')}</Text>
            <Text size="xs" color="tertiary">{t('proBadgeNote')}</Text>
          </Box>
          <ToggleSwitch checked={props.showProBadge} onChange={(v) => props.setShowProBadge(v)} />
        </Box>
      </Box>

      {/* DM Permission */}
      <Box>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('dmPermissionsTitle')}
        </Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          <RadioOption name="dmPermission" value="all" currentValue={props.dmPermission} label={t('dmEveryoneLabel')} description={t('dmEveryoneDesc')} onChange={props.setDmPermission} />
          <RadioOption name="dmPermission" value="mutual" currentValue={props.dmPermission} label={t('dmMutualLabel')} description={t('dmMutualDesc')} onChange={props.setDmPermission} />
          <RadioOption name="dmPermission" value="none" currentValue={props.dmPermission} label={t('dmNoneLabel')} description={t('dmNoneDesc')} onChange={props.setDmPermission} />
        </Box>
      </Box>

      {/* Blocked Users */}
      <Box style={{ marginTop: tokens.spacing[5], paddingTop: tokens.spacing[5], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('blockedUsersTitle')}
        </Text>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
          {t('blockedUsersDesc')}
        </Text>

        {props.loadingBlockedUsers ? (
          <Text size="sm" color="tertiary">{t('loading')}</Text>
        ) : props.blockedUsers.length === 0 ? (
          <Box style={{
            padding: tokens.spacing[4],
            textAlign: 'center',
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.primary,
          }}>
            <Text size="sm" color="tertiary">{t('noBlockedUsers')}</Text>
          </Box>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {props.blockedUsers.map((blockedUser) => (
              <Box
                key={blockedUser.blockedId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                  <Box
                    style={{
                      width: 32, height: 32,
                      borderRadius: tokens.radius.full,
                      background: blockedUser.avatarUrl
                        ? `url(${blockedUser.avatarUrl}) center/cover no-repeat`
                        : `${tokens.colors.accent.primary}15`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {!blockedUser.avatarUrl && (
                      <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                        {(blockedUser.handle?.[0] || '?').toUpperCase()}
                      </Text>
                    )}
                  </Box>
                  <Box>
                    <Text size="sm" weight="medium">{blockedUser.handle || t('unknownUser')}</Text>
                    <Text size="xs" color="tertiary">{t('blockedAt')} {formatTimeAgo(blockedUser.createdAt)}</Text>
                  </Box>
                </Box>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onUnblock(blockedUser.blockedId)}
                  disabled={props.unblockingId === blockedUser.blockedId}
                  style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.accent.primary }}
                >
                  {props.unblockingId === blockedUser.blockedId ? '...' : t('unblockButton')}
                </Button>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </SectionCard>
  )
})

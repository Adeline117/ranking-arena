'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { SectionCard } from './shared'
import { MultiAccountSection } from './MultiAccountSection'

interface AccountSectionProps {
  onLogout: () => void
  onDeleteAccount: () => void
}

export const AccountSection = React.memo(function AccountSection({ onLogout, onDeleteAccount }: AccountSectionProps) {
  const { t } = useLanguage()

  return (
    <SectionCard id="account" title={t('accountSection')} variant="danger">
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {/* Multi-Account Section */}
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[2] }}>
            <Box>
              <Text size="sm" weight="medium">{t('linkedAccountsTitle')}</Text>
              <Text size="xs" color="tertiary">{t('linkedAccountsDesc')}</Text>
            </Box>
          </Box>
          <MultiAccountSection />
        </Box>

        <Box style={{ height: 1, background: tokens.colors.border.primary }} />

        {/* Logout */}
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Text size="sm" weight="medium">{t('logout')}</Text>
            <Text size="xs" color="tertiary">{t('logoutDesc')}</Text>
          </Box>
          <Button
            variant="secondary"
            size="sm"
            onClick={onLogout}
            style={{ color: tokens.colors.accent.error, borderColor: tokens.colors.accent.error + '40' }}
          >
            {t('logout')}
          </Button>
        </Box>

        <Box style={{ height: 1, background: tokens.colors.border.primary }} />

        {/* Account Deletion */}
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Text size="sm" weight="medium" style={{ color: tokens.colors.accent.error }}>{t('deleteAccount')}</Text>
            <Text size="xs" color="tertiary">{t('deleteAccountDesc2')}</Text>
          </Box>
          <Button
            variant="secondary"
            size="sm"
            onClick={onDeleteAccount}
            style={{ color: tokens.colors.accent.error, borderColor: tokens.colors.accent.error + '40' }}
          >
            {t('deleteAccount')}
          </Button>
        </Box>
      </Box>
    </SectionCard>
  )
})

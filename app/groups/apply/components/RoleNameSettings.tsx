'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { inputStyle } from '../styles'
import type { RoleNames } from '../types'

interface RoleNameSettingsProps {
  roleNames: RoleNames
  setRoleNames: (names: RoleNames) => void
}

export function RoleNameSettings({ roleNames, setRoleNames }: RoleNameSettingsProps) {
  const { t } = useLanguage()

  return (
    <Box>
      <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
        {t('roleNameSettings')}
      </Text>
      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
        {t('roleNameSettingsDesc')}
      </Text>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
          <Text size="sm" color="secondary">
            {t('adminRole')}
          </Text>
          <input
            type="text"
            value={roleNames.admin.zh}
            onChange={(e) => setRoleNames({ ...roleNames, admin: { ...roleNames.admin, zh: e.target.value } })}
            placeholder={t('adminRoleZhPlaceholder')}
            style={{ ...inputStyle, padding: tokens.spacing[2] }}
            maxLength={20}
          />
          <input
            type="text"
            value={roleNames.admin.en}
            onChange={(e) => setRoleNames({ ...roleNames, admin: { ...roleNames.admin, en: e.target.value } })}
            placeholder="English (e.g., Leader)"
            style={{ ...inputStyle, padding: tokens.spacing[2] }}
            maxLength={20}
          />
        </Box>

        <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
          <Text size="sm" color="secondary">
            {t('groupMember')}
          </Text>
          <input
            type="text"
            value={roleNames.member.zh}
            onChange={(e) => setRoleNames({ ...roleNames, member: { ...roleNames.member, zh: e.target.value } })}
            placeholder={t('memberRoleZhPlaceholder')}
            style={{ ...inputStyle, padding: tokens.spacing[2] }}
            maxLength={20}
          />
          <input
            type="text"
            value={roleNames.member.en}
            onChange={(e) => setRoleNames({ ...roleNames, member: { ...roleNames.member, en: e.target.value } })}
            placeholder="English (e.g., Disciple)"
            style={{ ...inputStyle, padding: tokens.spacing[2] }}
            maxLength={20}
          />
        </Box>
      </Box>
    </Box>
  )
}

"use client"

import Link from "next/link"
import { Box, Text, Button } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function GroupActions({ groupId }: { groupId: string }) {
  const { t, language: _language } = useLanguage()

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.secondary,
      }}
    >
      <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
        {t('groupActionsTitle')}
      </Text>

      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
        <Link href={`/groups/${groupId}/new`} style={{ textDecoration: 'none' }}>
          <Button variant="secondary" size="sm">
            {t('newPostButton')}
          </Button>
        </Link>
      </Box>
    </Box>
  )
}

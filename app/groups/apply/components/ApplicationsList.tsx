'use client'

import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import Card from '@/app/components/ui/Card'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { StatusBadge } from './StatusBadge'

interface GroupApplication {
  id: string
  name: string
  created_at: string
  status: string
}

interface ApplicationsListProps {
  applications: GroupApplication[]
}

export function ApplicationsList({ applications }: ApplicationsListProps) {
  const { t, language } = useLanguage()

  if (applications.length === 0) return null

  return (
    <Card title={t('myApplications')} style={{ marginBottom: tokens.spacing[6] }}>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {applications.map((app) => (
          <Box
            key={app.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: tokens.spacing[3],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: ('1px solid ' + tokens.colors.border.primary),
            }}
          >
            <Box>
              <Text weight="bold">{app.name}</Text>
              <Text size="xs" color="tertiary">
                {new Date(app.created_at).toLocaleString(getLocaleFromLanguage(language))}
              </Text>
            </Box>
            <StatusBadge status={app.status} />
          </Box>
        ))}
      </Box>
    </Card>
  )
}

'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface SuccessViewProps {
  email: string | undefined
  onApplyAnother: () => void
}

export function SuccessView({ email, onApplyAnother }: SuccessViewProps) {
  const { t } = useLanguage()

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box as="main" style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Card title={t('groupApplyCreated')}>
          <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
            <Box style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'var(--color-accent-primary-20)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              marginBottom: tokens.spacing[4],
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </Box>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('groupCreatedSuccess')}
            </Text>
            <Text color="tertiary" style={{ marginBottom: tokens.spacing[6] }}>
              {t('groupCreatedDesc')}
            </Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center' }}>
              <Button variant="secondary" onClick={onApplyAnother}>
                {t('applyAnother')}
              </Button>
              <Link href="/groups">
                <Button variant="primary">
                  {t('backToGroups')}
                </Button>
              </Link>
            </Box>
          </Box>
        </Card>
      </Box>
    </Box>
  )
}

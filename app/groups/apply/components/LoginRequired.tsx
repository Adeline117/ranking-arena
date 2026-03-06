'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface LoginRequiredProps {
  email: string | undefined
}

export function LoginRequired({ email }: LoginRequiredProps) {
  const { t } = useLanguage()

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box as="main" style={{ maxWidth: 600, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Card title={t('applyCreateGroup')}>
          <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
            <Text size="lg" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
              {t('groupApplyLoginRequired')}
            </Text>
            <Link href="/login?redirect=/groups/apply">
              <Button variant="primary">
                {t('goToLogin')}
              </Button>
            </Link>
          </Box>
        </Card>
      </Box>
    </Box>
  )
}

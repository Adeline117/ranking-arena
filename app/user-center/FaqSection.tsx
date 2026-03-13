'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { getFaqData } from './membership-config'

interface FaqSectionProps {
  cardStyle: React.CSSProperties
  t: (key: string) => string
}

export default function FaqSection({ cardStyle, t }: FaqSectionProps) {
  return (
    <div style={cardStyle}>
      <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[4], color: tokens.colors.text.primary }}>
        {t('faq')}
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {getFaqData(t).map((faq, index) => (
          <Box
            key={index}
            style={{
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.secondary}`,
            }}
          >
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              {faq.q}
            </Text>
            <Text size="xs" color="secondary" style={{ lineHeight: 1.6 }}>
              {faq.a}
            </Text>
          </Box>
        ))}
      </Box>

      <Box style={{ marginTop: tokens.spacing[4], textAlign: 'center' }}>
        <Text size="xs" color="tertiary">
          {t('haveMoreQuestions')}
          <Link
            href="/help"
            style={{
              color: 'var(--color-pro-gradient-start)',
              marginLeft: 4,
              textDecoration: 'none',
            }}
          >
            {t('contactUs')}
          </Link>
        </Text>
      </Box>
    </div>
  )
}

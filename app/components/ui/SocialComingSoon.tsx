'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

/**
 * Full-page "Coming Soon" state shown when social features are disabled.
 * Used instead of notFound() for social-gated pages so users see a proper
 * explanation rather than a confusing 404.
 */
export default function SocialComingSoon() {
  const { t } = useLanguage()

  return (
    <Box
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.spacing[6],
        textAlign: 'center',
      }}
    >
      {/* Icon */}
      <Box
        style={{
          width: 80,
          height: 80,
          borderRadius: tokens.radius.full,
          background: tokens.gradient.primarySubtle,
          border: `1px solid var(--color-accent-primary-20)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: tokens.spacing[6],
        }}
      >
        <svg
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </Box>

      {/* Title */}
      <Text
        size="xl"
        weight="bold"
        style={{ marginBottom: tokens.spacing[3], color: tokens.colors.text.primary }}
      >
        {t('socialComingSoonTitle')}
      </Text>

      {/* Description */}
      <Text
        size="base"
        style={{
          color: tokens.colors.text.secondary,
          maxWidth: 420,
          marginBottom: tokens.spacing[6],
          lineHeight: 1.6,
        }}
      >
        {t('socialComingSoonDescription')}
      </Text>

      {/* CTA */}
      <Link
        href="/rankings"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 44,
          padding: '12px 28px',
          background: tokens.colors.accent.brand,
          color: tokens.colors.white,
          borderRadius: tokens.radius.lg,
          textDecoration: 'none',
          fontWeight: 700,
          fontSize: 15,
          transition: `opacity ${tokens.transition.base}`,
        }}
      >
        {t('socialComingSoonCta')}
      </Link>
    </Box>
  )
}

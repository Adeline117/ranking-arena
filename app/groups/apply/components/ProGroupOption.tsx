'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface ProGroupOptionProps {
  isPro: boolean
  isPremiumOnly: boolean
  setIsPremiumOnly: (v: boolean) => void
}

export function ProGroupOption({ isPro, isPremiumOnly, setIsPremiumOnly }: ProGroupOptionProps) {
  const { t } = useLanguage()

  if (isPro) {
    return (
      <Box
        style={{
          padding: tokens.spacing[4],
          background: 'var(--color-pro-glow)',
          borderRadius: tokens.radius.lg,
          border: '1px solid var(--color-pro-gradient-start)',
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3] }}>
          <Box
            onClick={() => setIsPremiumOnly(!isPremiumOnly)}
            style={{
              width: 20,
              height: 20,
              borderRadius: tokens.radius.sm,
              border: isPremiumOnly
                ? '2px solid var(--color-pro-gradient-start)'
                : '2px solid var(--color-border-secondary)',
              background: isPremiumOnly ? 'var(--color-pro-gradient-start)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
              marginTop: 2,
              transition: 'all 0.2s',
            }}
          >
            {isPremiumOnly && (
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--color-on-accent)" strokeWidth="3">
                <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </Box>
          <Box style={{ flex: 1 }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: 4 }}>
              <Text weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
                {t('proExclusiveGroup')}
              </Text>
              <Box
                style={{
                  padding: '2px 6px',
                  borderRadius: tokens.radius.full,
                  background: 'var(--color-pro-badge-bg)',
                  fontSize: 10,
                  fontWeight: 700,
                  color: tokens.colors.white,
                }}
              >
                Pro
              </Box>
            </Box>
            <Text size="sm" color="secondary" style={{ lineHeight: 1.5 }}>
              {t('proExclusiveGroupDesc')}
            </Text>
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: 'var(--color-bg-secondary)',
        borderRadius: tokens.radius.lg,
        border: '1px solid var(--color-border-primary)',
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
        <Box
          style={{
            width: 36,
            height: 36,
            borderRadius: tokens.radius.md,
            background: 'var(--color-pro-glow)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="var(--color-pro-gradient-start)">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
        </Box>
        <Box style={{ flex: 1 }}>
          <Text size="sm" weight="semibold" style={{ marginBottom: 2 }}>
            {t('upgradeProForGroups')}
          </Text>
          <Text size="xs" color="tertiary">
            {t('proGroupDescFree')}
          </Text>
        </Box>
        <Link href="/pricing" style={{ textDecoration: 'none' }}>
          <Button
            variant="secondary"
            size="sm"
            style={{
              background: 'var(--color-pro-glow)',
              border: '1px solid var(--color-pro-gradient-start)',
              color: 'var(--color-pro-gradient-start)',
              fontWeight: 600,
            }}
          >
            {t('upgrade')}
          </Button>
        </Link>
      </Box>
    </Box>
  )
}

'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'

interface PortfolioProLockProps {
  onUnlock?: () => void
}

export default function PortfolioProLock({ onUnlock }: PortfolioProLockProps) {
  const { t } = useLanguage()

  return (
    <Box
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <Box
        style={{
          background: `linear-gradient(135deg, ${tokens.colors.bg.primary}F0, ${tokens.colors.bg.secondary}E8)`,
          backdropFilter: tokens.glass.blur.xs,
          WebkitBackdropFilter: tokens.glass.blur.xs,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          border: `1px solid ${tokens.colors.accent.primary}40`,
          boxShadow: `0 8px 32px var(--color-accent-primary-20)`,
          textAlign: 'center',
          pointerEvents: 'auto',
          maxWidth: 360,
        }}
      >
        <Box style={{
          width: 48,
          height: 48,
          borderRadius: tokens.radius.full,
          background: `linear-gradient(135deg, ${tokens.colors.accent.primary}30, ${tokens.colors.accent.brand}20)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto',
          marginBottom: tokens.spacing[4],
        }}>
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </Box>
        <Text size="lg" weight="bold" style={{ color: tokens.colors.text.primary, marginBottom: tokens.spacing[2] }}>
          {t('unlockFullPortfolio')}
        </Text>
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
          {t('unlockFullPortfolioDesc')}
        </Text>
        {onUnlock && (
          <button
            onClick={onUnlock}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
              borderRadius: tokens.radius.lg,
              border: 'none',
              background: `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
              color: tokens.colors.white,
              fontWeight: tokens.typography.fontWeight.bold,
              fontSize: tokens.typography.fontSize.sm,
              cursor: 'pointer',
              transition: 'all 0.25s ease',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {t('upgradeToProBtn')}
          </button>
        )}
      </Box>
    </Box>
  )
}

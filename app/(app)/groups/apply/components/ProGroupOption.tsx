'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ProGate from '@/app/components/ui/ProGate'

interface ProGroupOptionProps {
  isPro: boolean
  isPremiumOnly: boolean
  setIsPremiumOnly: (v: boolean) => void
}

/**
 * Pro-exclusive group toggle. Free users see the option blurred behind
 * ProGate (feature preview, checkbox non-interactive via pointerEvents:none);
 * Pro users get the live checkbox. Submission is additionally guarded
 * server-side via `is_premium_only: isPro && isPremiumOnly` in the form hooks.
 */
export function ProGroupOption({ isPremiumOnly, setIsPremiumOnly }: ProGroupOptionProps) {
  const { t } = useLanguage()

  return (
    <ProGate variant="blur" featureKey="proGroupDescFree">
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
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-on-accent)"
                strokeWidth="3"
              >
                <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </Box>
          <Box style={{ flex: 1 }}>
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                marginBottom: 4,
              }}
            >
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
    </ProGate>
  )
}

'use client'

import { type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useSubscription } from '../home/hooks/useSubscription'

interface ProFeatureTeaserProps {
  /** Content to show (partially visible for free users) */
  children: ReactNode
  /** Max height before truncation for free users */
  previewHeight?: number
  /** Feature name for CTA text */
  featureLabel?: string
  /** Custom CTA text override */
  ctaText?: string
  /** Whether to show content at all (vs just CTA) */
  showPreview?: boolean
}

/**
 * ProFeatureTeaser - Shows partial content with a purple gradient CTA for non-Pro users.
 * Content renders normally but is truncated/limited with a fade + upgrade prompt.
 * Pro users see full content with no overlay.
 */
export default function ProFeatureTeaser({
  children,
  previewHeight = 200,
  featureLabel,
  ctaText,
  showPreview = true,
}: ProFeatureTeaserProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const { isPro } = useSubscription()

  if (isPro) {
    return <>{children}</>
  }

  return (
    <div className="pro-feature-teaser">
      {showPreview && (
        <div
          style={{
            maxHeight: previewHeight,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {children}
          {/* Fade gradient overlay */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 80,
              background: `linear-gradient(transparent, var(--color-bg-secondary))`,
              pointerEvents: 'none',
            }}
          />
        </div>
      )}

      {/* CTA Block */}
      <Box
        style={{
          padding: `${tokens.spacing[5]} ${tokens.spacing[4]}`,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[3],
          background: `linear-gradient(180deg, var(--color-bg-secondary) 0%, var(--color-pro-glow) 100%)`,
          borderRadius: tokens.radius.lg,
          border: '1px solid var(--color-pro-gradient-start)',
        }}
      >
        {/* Star icon */}
        <svg width={24} height={24} viewBox="0 0 24 24" fill="var(--color-pro-gradient-start)">
          <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
        </svg>

        <Text size="md" weight="bold">
          {featureLabel
            ? `${t('unlockProFeatures')}: ${featureLabel}`
            : t('unlockProFeatures')}
        </Text>

        <Text size="sm" color="tertiary" style={{ maxWidth: 320 }}>
          {t('proFeatureBlurred')}
        </Text>

        <button
          className="pro-feature-teaser-cta"
          onClick={() => router.push('/pricing')}
        >
          {ctaText || t('upgradeToPro')}
        </button>
      </Box>
    </div>
  )
}

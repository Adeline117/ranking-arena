'use client'

/**
 * ProGate — the ONE way to gate Pro features (Wave-3 unification).
 *
 * Replaces ad-hoc `isPro ? ... : ...` scattered across routes so the upsell
 * moment looks and behaves the same everywhere.
 *
 *   <ProGate variant="blur">   — children render blurred + non-interactive,
 *                                upsell card overlaid (previews the feature)
 *   <ProGate variant="inline"> — children replaced by the upsell card
 *                                (list truncation, locked sections)
 *   <ProGate variant="modal">  — children render as a locked trigger; any
 *                                click opens an upsell ModalOverlay
 *
 * isPro comes from the same useSubscription() hook the leaderboard gate
 * already uses (beta flag respected). While subscription state is loading
 * children render ungated to avoid a paywall flash for actual Pro users.
 */

import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import ModalOverlay from './ModalOverlay'
import { useLanguage } from '../Providers/LanguageProvider'
import { useSubscription } from '../home/hooks/useSubscription'

export interface ProGateProps {
  children: ReactNode
  variant?: 'blur' | 'inline' | 'modal'
  /** i18n key for the upsell description (defaults to generic Pro copy). */
  featureKey?: string
  /** Reserve height for the inline/blur card to avoid CLS. */
  fallbackHeight?: number
}

function StarIcon({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="var(--color-pro-gradient-start, var(--color-accent-primary))"
      aria-hidden="true"
    >
      <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
    </svg>
  )
}

function UpsellCard({
  featureKey,
  minHeight,
  onUpgrade,
  t,
}: {
  featureKey: string
  minHeight?: number
  onUpgrade: () => void
  t: (key: string) => string
}) {
  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[3],
        padding: `${tokens.spacing[5]} ${tokens.spacing[6]}`,
        background: 'var(--color-bg-secondary)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-pro-border, var(--color-border-primary))',
        textAlign: 'center',
        minHeight,
      }}
    >
      <StarIcon />
      <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary }}>
        {t('proFeature')}
      </Text>
      <Text size="sm" style={{ color: tokens.colors.text.tertiary, lineHeight: 1.5 }}>
        {t(featureKey)}
      </Text>
      <button
        onClick={onUpgrade}
        className="tap-target"
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
          background: 'var(--color-pro-badge-bg, var(--color-accent-primary))',
          color: tokens.colors.white,
          border: 'none',
          borderRadius: tokens.radius.md,
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.bold,
          cursor: 'pointer',
        }}
      >
        {t('upgradeToPro')}
      </button>
    </Box>
  )
}

export default function ProGate({
  children,
  variant = 'inline',
  featureKey = 'proFeatureBlurred',
  fallbackHeight,
}: ProGateProps) {
  const { t } = useLanguage()
  const router = useRouter()
  const { isPro, isLoading } = useSubscription()
  const [modalOpen, setModalOpen] = useState(false)

  // Pro users and the loading window render ungated — a transient paywall
  // flash for paying users is worse than a delayed gate for free users.
  if (isPro || isLoading) return <>{children}</>

  const goUpgrade = () => router.push('/pricing')

  if (variant === 'blur') {
    return (
      <div style={{ position: 'relative', minHeight: fallbackHeight }}>
        <div style={{ filter: 'blur(6px)', pointerEvents: 'none', userSelect: 'none' }} aria-hidden>
          {children}
        </div>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2,
          }}
        >
          <UpsellCard featureKey={featureKey} onUpgrade={goUpgrade} t={t} />
        </div>
      </div>
    )
  }

  if (variant === 'modal') {
    return (
      <>
        <div
          role="button"
          tabIndex={0}
          aria-label={t('proOnly')}
          onClickCapture={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setModalOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setModalOpen(true)
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          {children}
        </div>
        <ModalOverlay
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          label={t('proFeature')}
          maxWidth={380}
        >
          <div style={{ padding: tokens.spacing[6] }}>
            <UpsellCard featureKey={featureKey} onUpgrade={goUpgrade} t={t} />
          </div>
        </ModalOverlay>
      </>
    )
  }

  // inline
  return (
    <UpsellCard featureKey={featureKey} minHeight={fallbackHeight} onUpgrade={goUpgrade} t={t} />
  )
}

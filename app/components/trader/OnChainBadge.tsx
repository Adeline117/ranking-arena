'use client'

/**
 * OnChainBadge
 *
 * Shows an "On-chain Verified" badge on trader profiles
 * when their Arena Score has been attested on-chain via EAS.
 */

import { useState, useEffect } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

interface OnChainBadgeProps {
  traderHandle: string
  size?: 'sm' | 'md' | 'lg'
}

interface AttestationInfo {
  attestation_uid: string
  arena_score: number | null
  published_at: string
}

const SIZE_CONFIG = {
  sm: { icon: 16, text: 'text-[10px]', gap: 'gap-[3px]' },
  md: { icon: 20, text: 'text-xs', gap: 'gap-1' },
  lg: { icon: 24, text: 'text-sm', gap: 'gap-1.5' },
} as const

export function OnChainBadge({ traderHandle, size = 'md' }: OnChainBadgeProps) {
  const { t } = useLanguage()
  const [attestation, _setAttestation] = useState<AttestationInfo | null>(null)
  const [showTooltip, setShowTooltip] = useState(false)

  useEffect(() => {
    async function checkAttestation() {
      try {
        const { supabase } = await import('@/lib/supabase/client')
        // trader_attestations table not yet created — skip query
        // const { data } = await supabase
        //   .from('trader_attestations')
        //   .select('attestation_uid, arena_score, published_at')
        //   .eq('trader_handle', traderHandle)
        //   .maybeSingle()
        // if (data) setAttestation(data)
        void supabase // suppress unused
      } catch {
        // Intentionally swallowed: on-chain attestation check is optional UI enrichment
      }
    }

    checkAttestation()
  }, [traderHandle])

  if (!attestation) return null

  const s = SIZE_CONFIG[size]

  const publishedDate = attestation.published_at
    ? new Date(attestation.published_at).toLocaleDateString()
    : ''

  return (
    <div
      className={`relative inline-flex items-center ${s.gap}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <svg
        width={s.icon}
        height={s.icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke={tokens.colors.verified.onchain}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>

      <span className={`${s.text} font-semibold text-[var(--color-verified-onchain)] whitespace-nowrap`}>
        {t('onChainVerified')}
      </span>

      {showTooltip && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3.5 py-2.5 whitespace-nowrap z-50"
          style={{
            background: tokens.glass.bg.heavy,
            backdropFilter: tokens.glass.blur.lg,
            WebkitBackdropFilter: tokens.glass.blur.lg,
            border: `1px solid var(--color-verified-onchain, var(--color-accent-success-20))`,
            borderRadius: tokens.radius.lg,
            boxShadow: tokens.shadow.lg,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.xs,
          }}
        >
          <div className="font-semibold mb-1" style={{ color: tokens.colors.verified.onchain }}>
            {t('onChainAttestedOnBase')}
          </div>
          {attestation.arena_score != null && (
            <div>{t('onChainScore')}: {attestation.arena_score}</div>
          )}
          <div>{t('onChainPublished')}: {publishedDate}</div>
          <div className="mt-1" style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
            {t('onChainUid')}: {attestation.attestation_uid.slice(0, 10)}...
          </div>
        </div>
      )}
    </div>
  )
}

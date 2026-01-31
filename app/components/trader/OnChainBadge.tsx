'use client'

/**
 * OnChainBadge
 *
 * Shows an "On-chain Verified" badge on trader profiles
 * when their Arena Score has been attested on-chain via EAS.
 */

import { useState, useEffect } from 'react'

interface OnChainBadgeProps {
  traderHandle: string
  size?: 'sm' | 'md' | 'lg'
}

interface AttestationInfo {
  attestation_uid: string
  arena_score: number | null
  published_at: string
}

export function OnChainBadge({ traderHandle, size = 'md' }: OnChainBadgeProps) {
  const [attestation, setAttestation] = useState<AttestationInfo | null>(null)
  const [showTooltip, setShowTooltip] = useState(false)

  useEffect(() => {
    // Fetch attestation status from Supabase
    async function checkAttestation() {
      try {
        const { supabase } = await import('@/lib/supabase/client')
        const { data } = await supabase
          .from('trader_attestations')
          .select('attestation_uid, arena_score, published_at')
          .eq('trader_handle', traderHandle)
          .maybeSingle()

        if (data) setAttestation(data)
      } catch {
        // Non-critical — fail silently
      }
    }

    checkAttestation()
  }, [traderHandle])

  if (!attestation) return null

  const sizes = {
    sm: { badge: 16, font: 10, gap: 3 },
    md: { badge: 20, font: 12, gap: 4 },
    lg: { badge: 24, font: 14, gap: 6 },
  }
  const s = sizes[size]

  const publishedDate = attestation.published_at
    ? new Date(attestation.published_at).toLocaleDateString()
    : ''

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: s.gap }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Shield icon with checkmark */}
      <svg
        width={s.badge}
        height={s.badge}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#2fe57d"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>

      <span style={{
        fontSize: s.font,
        fontWeight: 600,
        color: '#2fe57d',
        whiteSpace: 'nowrap',
      }}>
        On-chain Verified
      </span>

      {/* Tooltip */}
      {showTooltip && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: 8,
          padding: '10px 14px',
          background: 'rgba(15, 15, 20, 0.95)',
          border: '1px solid rgba(47, 229, 125, 0.2)',
          borderRadius: 10,
          fontSize: 12,
          color: '#d0d0d0',
          whiteSpace: 'nowrap',
          zIndex: 50,
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
        }}>
          <div style={{ fontWeight: 600, color: '#2fe57d', marginBottom: 4 }}>
            Arena Score Attested on Base
          </div>
          {attestation.arena_score != null && (
            <div>Score: {attestation.arena_score}</div>
          )}
          <div>Published: {publishedDate}</div>
          <div style={{ marginTop: 4, fontSize: 11, color: '#8a8a8a' }}>
            UID: {attestation.attestation_uid.slice(0, 10)}...
          </div>
        </div>
      )}
    </div>
  )
}

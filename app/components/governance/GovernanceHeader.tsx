'use client'

/**
 * GovernanceHeader
 *
 * Hero section for the governance page.
 * Shows wallet connection status and voting eligibility.
 */

import { useAccount } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { usePremium } from '@/lib/premium/hooks'
import { tokens } from '@/lib/design-tokens'

export function GovernanceHeader() {
  const { isConnected, address } = useAccount()
  const { isPremium, hasNFT } = usePremium()

  return (
    <div className="mb-8">
      <h1 className="text-2xl font-black mb-2" style={{ letterSpacing: '-0.3px', color: 'var(--color-text-primary)' }}>
        Arena Governance
      </h1>
      <p className="text-[15px] leading-relaxed mb-6" style={{ color: 'var(--color-text-secondary)' }}>
        Shape the future of Arena. Pro NFT holders can vote on platform features,
        trader disputes, and community proposals via Snapshot (gasless).
      </p>

      {/* Wallet & Voting Status */}
      <div className="flex flex-wrap gap-3 items-center">
        {isConnected && address ? (
          <>
            {/* Connected indicator */}
            <div
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg"
              style={{ background: `color-mix(in srgb, var(--color-accent-success) 5%, transparent)`, border: `1px solid color-mix(in srgb, var(--color-accent-success) 20%, transparent)` }}
            >
              <div className="w-2 h-2 rounded-full" style={{ background: tokens.colors.accent.success }} />
              <span className="text-xs font-medium" style={{ color: tokens.colors.accent.success }}>
                {address.slice(0, 6)}...{address.slice(-4)}
              </span>
            </div>

            {/* Voting eligibility */}
            {isPremium || hasNFT ? (
              <div
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg"
                style={{ background: `color-mix(in srgb, var(--color-brand) 5%, transparent)`, border: `1px solid color-mix(in srgb, var(--color-brand) 20%, transparent)` }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.verified.web3} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
                <span className="text-xs font-semibold" style={{ color: tokens.colors.accent.brand }}>
                  Eligible to Vote
                </span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg" style={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-primary)' }}>
                <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                  Hold an Arena Pro NFT to vote
                </span>
              </div>
            )}
          </>
        ) : (
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button
                onClick={openConnectModal}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold cursor-pointer transition-colors"
                style={{ border: `1px solid color-mix(in srgb, var(--color-brand) 30%, transparent)`, background: `color-mix(in srgb, var(--color-brand) 10%, transparent)`, color: tokens.colors.accent.brandLight }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <path d="M22 10H18a2 2 0 0 0-2 2 2 2 0 0 0 2 2h4" />
                </svg>
                Connect Wallet to Vote
              </button>
            )}
          </ConnectButton.Custom>
        )}
      </div>
    </div>
  )
}

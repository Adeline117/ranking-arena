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
      <h1 className="text-[32px] font-extrabold text-neutral-200 mb-2">
        Arena Governance
      </h1>
      <p className="text-[15px] text-neutral-500 leading-relaxed mb-6">
        Shape the future of Arena. Pro NFT holders can vote on platform features,
        trader disputes, and community proposals via Snapshot (gasless).
      </p>

      {/* Wallet & Voting Status */}
      <div className="flex flex-wrap gap-3 items-center">
        {isConnected && address ? (
          <>
            {/* Connected indicator */}
            <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/5 border border-green-500/20">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-xs font-medium text-green-400">
                {address.slice(0, 6)}...{address.slice(-4)}
              </span>
            </div>

            {/* Voting eligibility */}
            {isPremium || hasNFT ? (
              <div className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-500/5 border border-purple-500/20">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.verified.web3} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
                <span className="text-xs font-semibold text-purple-400">
                  Eligible to Vote
                </span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <span className="text-xs text-neutral-500">
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
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-purple-500/30 bg-purple-500/10 text-purple-300 text-sm font-semibold cursor-pointer hover:bg-purple-500/15 transition-colors"
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

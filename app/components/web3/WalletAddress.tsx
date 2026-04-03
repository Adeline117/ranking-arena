'use client'

/**
 * WalletAddress
 *
 * Displays a truncated wallet address with a Basescan link and copy button.
 */

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import { getAddressExplorerUrl, type SupportedChainId, CHAIN_IDS } from '@/lib/web3/multi-chain'

interface WalletAddressProps {
  address: string
  /** Chain ID for explorer link. Defaults to Base mainnet. */
  chainId?: SupportedChainId
  showCopy?: boolean
  className?: string
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function WalletAddress({ address, chainId = CHAIN_IDS.BASE, showCopy = true, className = '' }: WalletAddressProps) {
  const [copied, setCopied] = useState(false)
  const { showToast } = useToast()

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      showToast('Copied!', 'success')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showToast('Copy failed', 'error')
    }
  }, [address, showToast])

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {/* Wallet icon */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-purple-400 shrink-0"
      >
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M22 10H18a2 2 0 0 0-2 2 2 2 0 0 0 2 2h4" />
      </svg>

      {/* Address link to block explorer */}
      <a
        href={getAddressExplorerUrl(chainId, address)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-mono hover:text-purple-400 transition-colors no-underline"
        style={{ color: 'var(--color-text-secondary)' }}
        title={address}
      >
        {shortenAddress(address)}
      </a>

      {/* Copy button */}
      {showCopy && (
        <button
          onClick={handleCopy}
          className="p-0 border-none bg-transparent cursor-pointer transition-colors"
          style={{ color: 'var(--color-text-tertiary)' }}
          title={copied ? 'Copied!' : 'Copy address'}
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.verified.onchain} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      )}
    </span>
  )
}

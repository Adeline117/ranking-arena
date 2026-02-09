'use client'

/**
 * ChainIndicator
 *
 * Displays the current connected blockchain network with status indicator.
 * Shows warning if user is on wrong network and provides switch functionality.
 */

import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { CHAIN_CONFIGS, CHAIN_IDS, type SupportedChainId } from '@/lib/web3/multi-chain'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface ChainIndicatorProps {
  size?: 'sm' | 'md'
  showName?: boolean
  className?: string
}

const CHAIN_ICONS: Record<number, { color: string; bg: string }> = {
  [CHAIN_IDS.BASE]: { color: 'var(--color-chart-indigo)', bg: 'var(--color-accent-primary-10)' },
  [CHAIN_IDS.BASE_SEPOLIA]: { color: 'var(--color-chart-indigo)', bg: 'var(--color-accent-primary-10)' },
  [CHAIN_IDS.ARBITRUM]: { color: 'var(--color-chart-blue)', bg: 'var(--color-accent-primary-10)' },
  [CHAIN_IDS.OPTIMISM]: { color: 'var(--color-accent-error)', bg: 'var(--color-accent-error-10)' },
  [CHAIN_IDS.POLYGON]: { color: 'var(--color-chart-violet)', bg: 'var(--color-accent-primary-10)' },
}

export function ChainIndicator({ size = 'sm', showName = true, className = '' }: ChainIndicatorProps) {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending } = useSwitchChain()
  const { t } = useLanguage()
  const [showDropdown, setShowDropdown] = useState(false)

  if (!isConnected) return null

  const chainConfig = CHAIN_CONFIGS[chainId as SupportedChainId]
  const isSupported = chainConfig?.isSupported ?? false
  const chainStyle = CHAIN_ICONS[chainId] || { color: 'var(--color-text-tertiary)', bg: 'var(--color-overlay-subtle)' }

  const sizes = {
    sm: { dot: 8, text: 11, px: 8, py: 4, icon: 12 },
    md: { dot: 10, text: 13, px: 12, py: 6, icon: 14 },
  }
  const s = sizes[size]

  const handleSwitchToBase = () => {
    const targetChain = process.env.NODE_ENV === 'production' ? CHAIN_IDS.BASE : CHAIN_IDS.BASE_SEPOLIA
    switchChain?.({ chainId: targetChain })
  }

  // Wrong network warning
  if (!isSupported) {
    return (
      <button
        onClick={handleSwitchToBase}
        disabled={isPending}
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: `${s.py}px ${s.px}px`,
          borderRadius: tokens.radius.md,
          background: 'var(--color-red-bg-light)',
          border: '1px solid var(--color-red-border)',
          cursor: isPending ? 'wait' : 'pointer',
          transition: 'all 0.2s ease',
        }}
        title={t('switchToBase') || 'Switch to Base'}
      >
        {/* Warning icon */}
        <svg
          width={s.icon}
          height={s.icon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-accent-error)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span style={{ fontSize: s.text, fontWeight: 600, color: 'var(--color-accent-error)' }}>
          {isPending ? (t('switching') || 'Switching...') : (t('wrongNetwork') || 'Wrong Network')}
        </span>
      </button>
    )
  }

  return (
    <div className={className} style={{ position: 'relative' }}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: `${s.py}px ${s.px}px`,
          borderRadius: tokens.radius.md,
          background: chainStyle.bg,
          border: `1px solid ${chainStyle.color}30`,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
        }}
      >
        {/* Status dot */}
        <span
          style={{
            width: s.dot,
            height: s.dot,
            borderRadius: '50%',
            background: 'var(--color-accent-success)',
            boxShadow: '0 0 6px var(--color-accent-success-20)',
          }}
        />

        {/* Chain icon (Base logo) */}
        <svg
          width={s.icon}
          height={s.icon}
          viewBox="0 0 24 24"
          fill={chainStyle.color}
        >
          <circle cx="12" cy="12" r="10" fill={chainStyle.color} />
          <path
            d="M12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C13.5 18 14.8 17.4 15.8 16.5L12 12V6Z"
            fill="white"
          />
        </svg>

        {showName && (
          <span style={{ fontSize: s.text, fontWeight: 600, color: chainStyle.color }}>
            {chainConfig?.shortName || 'Base'}
            {chainConfig?.isTestnet && (
              <span style={{ opacity: 0.7, marginLeft: 4 }}>(Testnet)</span>
            )}
          </span>
        )}

        {/* Dropdown arrow */}
        <svg
          width={10}
          height={10}
          viewBox="0 0 24 24"
          fill="none"
          stroke={chainStyle.color}
          strokeWidth="2"
          strokeLinecap="round"
          style={{
            transform: showDropdown ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {showDropdown && (
        <>
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
            }}
            onClick={() => setShowDropdown(false)}
          />
          <div
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: 4,
              minWidth: 180,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              boxShadow: '0 8px 24px var(--color-overlay-medium)',
              zIndex: 50,
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '8px 12px', borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
              <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, fontWeight: 600, textTransform: 'uppercase' }}>
                {t('selectNetwork') || 'Select Network'}
              </span>
            </div>

            {Object.values(CHAIN_CONFIGS)
              .filter(c => c.isSupported || c.id === chainId)
              .map(chain => {
                const style = CHAIN_ICONS[chain.id] || { color: 'var(--color-text-tertiary)', bg: 'var(--color-overlay-subtle)' }
                const isActive = chain.id === chainId

                return (
                  <button
                    key={chain.id}
                    onClick={() => {
                      if (!isActive) {
                        switchChain?.({ chainId: chain.id })
                      }
                      setShowDropdown(false)
                    }}
                    disabled={isPending}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      background: isActive ? style.bg : 'transparent',
                      border: 'none',
                      cursor: isPending ? 'wait' : 'pointer',
                      transition: 'background 0.15s ease',
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: isActive ? 'var(--color-accent-success)' : 'transparent',
                        border: isActive ? 'none' : `2px solid ${tokens.colors.border.primary}`,
                      }}
                    />
                    <span style={{ fontSize: 13, fontWeight: isActive ? 600 : 400, color: tokens.colors.text.primary }}>
                      {chain.name}
                    </span>
                    {chain.isTestnet && (
                      <span style={{ fontSize: 10, color: tokens.colors.text.tertiary, marginLeft: 'auto' }}>
                        Testnet
                      </span>
                    )}
                    {!chain.isSupported && (
                      <span style={{ fontSize: 10, color: tokens.colors.accent.warning, marginLeft: 'auto' }}>
                        Soon
                      </span>
                    )}
                  </button>
                )
              })}
          </div>
        </>
      )}
    </div>
  )
}

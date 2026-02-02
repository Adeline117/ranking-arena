'use client'

/**
 * WalletSection
 *
 * Settings section for managing Web3 wallet connection.
 * Allows users to link/unlink their wallet and view NFT membership status.
 */

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useSiweAuth } from '@/lib/web3/useSiweAuth'
import { useWallet } from '@/lib/web3/useWallet'
import { usePremium } from '@/lib/premium/hooks'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

interface WalletSectionProps {
  onToast: (message: string, type: 'success' | 'error') => void
  onConfirm: (title: string, message: string) => Promise<boolean>
}

export function WalletSection({ onToast, onConfirm }: WalletSectionProps) {
  const { address: connectedAddress, isConnected } = useAccount()
  const { linkWallet, isLoading: linkLoading, error: siweError, clearError } = useSiweAuth()
  const { linkedAddress, hasNFT, isLoading: walletLoading, unlinkWallet, refresh } = useWallet()
  const { tier } = usePremium()
  const { t } = useLanguage()
  const [unlinking, setUnlinking] = useState(false)

  const handleLinkWallet = async () => {
    clearError()
    const result = await linkWallet()
    if (result) {
      onToast(t('walletLinkedSuccess'), 'success')
      refresh()
    }
  }

  const handleUnlinkWallet = async () => {
    const confirmed = await onConfirm(
      t('walletUnlinkTitle'),
      t('walletUnlinkConfirm')
    )
    if (!confirmed) return

    setUnlinking(true)
    const success = await unlinkWallet()
    setUnlinking(false)

    if (success) {
      onToast(t('walletUnlinked'), 'success')
    } else {
      onToast(t('walletUnlinkFailed'), 'error')
    }
  }

  if (walletLoading) {
    return (
      <Box style={{ padding: tokens.spacing[4] }}>
        <div className="h-20 rounded-xl bg-white/[0.03] animate-pulse" />
      </Box>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {/* Linked Wallet Status */}
      {linkedAddress ? (
        <Box
          style={{
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            background: tokens.colors.bg.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
              {/* Wallet icon */}
              <Box
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: tokens.radius.md,
                  background: 'rgba(99, 102, 241, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <path d="M22 10H18a2 2 0 0 0-2 2 2 2 0 0 0 2 2h4" />
                </svg>
              </Box>
              <Box>
                <Text size="sm" weight="bold" style={{ marginBottom: 2 }}>
                  {t('walletLinkedHeading')}
                </Text>
                <Text size="xs" color="secondary" style={{ fontFamily: 'monospace' }}>
                  {shortenAddress(linkedAddress)}
                </Text>
              </Box>
            </Box>
            <Button
              onClick={handleUnlinkWallet}
              disabled={unlinking}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.accent.error}30`,
                background: 'transparent',
                color: tokens.colors.accent.error,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: 600,
                cursor: unlinking ? 'not-allowed' : 'pointer',
                opacity: unlinking ? 0.5 : 1,
              }}
            >
              {unlinking ? t('walletUnlinking') : t('walletUnlink')}
            </Button>
          </Box>

          {/* Basescan link */}
          <Box style={{ marginTop: tokens.spacing[2] }}>
            <a
              href={`https://basescan.org/address/${linkedAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.accent.primary,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {t('walletViewOnBasescan')}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </Box>
        </Box>
      ) : (
        <Box
          style={{
            padding: tokens.spacing[5],
            borderRadius: tokens.radius.lg,
            background: tokens.colors.bg.tertiary,
            border: `1px dashed ${tokens.colors.border.primary}`,
            textAlign: 'center',
          }}
        >
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
            {t('walletNoLinked')}
          </Text>

          {isConnected && connectedAddress ? (
            <Button
              onClick={handleLinkWallet}
              disabled={linkLoading}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                color: '#fff',
                fontWeight: 700,
                fontSize: tokens.typography.fontSize.sm,
                cursor: linkLoading ? 'not-allowed' : 'pointer',
                opacity: linkLoading ? 0.6 : 1,
              }}
            >
              {linkLoading
                ? t('walletSigning')
                : `${t('walletLinkButton')} (${shortenAddress(connectedAddress)})`
              }
            </Button>
          ) : (
            <ConnectButton.Custom>
              {({ openConnectModal }) => (
                <Button
                  onClick={openConnectModal}
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid rgba(139, 111, 168, 0.3)`,
                    background: 'rgba(139, 111, 168, 0.08)',
                    color: '#c9b8db',
                    fontWeight: 700,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: 'pointer',
                  }}
                >
                  {t('walletConnectButton')}
                </Button>
              )}
            </ConnectButton.Custom>
          )}
        </Box>
      )}

      {/* SIWE Error */}
      {siweError && (
        <Text size="xs" style={{ color: tokens.colors.accent.error }}>
          {siweError}
        </Text>
      )}

      {/* NFT Membership Status */}
      {linkedAddress && (
        <Box
          style={{
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            background: hasNFT
              ? 'rgba(47, 229, 125, 0.05)'
              : tokens.colors.bg.tertiary,
            border: `1px solid ${hasNFT ? 'rgba(47, 229, 125, 0.2)' : tokens.colors.border.primary}`,
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Box
              style={{
                width: 40,
                height: 40,
                borderRadius: tokens.radius.md,
                background: hasNFT ? 'rgba(47, 229, 125, 0.1)' : 'rgba(255, 255, 255, 0.03)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={hasNFT ? '#2fe57d' : '#6a6a6a'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                {hasNFT && <path d="M9 12l2 2 4-4" />}
              </svg>
            </Box>
            <Box>
              <Text size="sm" weight="bold" style={{ color: hasNFT ? '#2fe57d' : tokens.colors.text.secondary }}>
                {hasNFT ? t('walletProNft') : t('walletNoNft')}
              </Text>
              <Text size="xs" color="tertiary">
                {hasNFT
                  ? t('walletProStatus').replace('{tier}', tier)
                  : t('walletHoldNft')
                }
              </Text>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  )
}

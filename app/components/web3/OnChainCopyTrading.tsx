'use client'

/**
 * OnChainCopyTrading
 *
 * On-chain copy trading component showing subscription status and controls.
 * Currently shows "Coming Soon" since contracts are not yet deployed.
 *
 * When deployed, this will allow users to:
 * - Subscribe to trader strategies with custom allocation
 * - Set stop-loss and leverage limits
 * - View current positions and PnL
 * - Emergency exit positions
 */

import { useAccount } from 'wagmi'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { isCopyTradingAvailable } from '@/lib/web3/copy-trading'
import { ChainIndicator } from './ChainIndicator'

interface OnChainCopyTradingProps {
  traderHandle: string
  traderAddress?: string
  className?: string
}

// Rocket icon for coming soon
const RocketIcon = ({ size = 24 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </svg>
)

// Lock icon for not available
const _LockIcon = ({ size = 20 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

// Chain icon
const ChainIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)

export function OnChainCopyTrading({ traderHandle, className = '' }: OnChainCopyTradingProps) {
  const { isConnected, chainId } = useAccount()
  const { t } = useLanguage()
  const { showToast } = useToast()

  // Check if copy trading is available on current chain
  const isAvailable = chainId ? isCopyTradingAvailable(chainId) : false

  // Features to show in coming soon
  const upcomingFeatures = [
    { icon: '1', label: t('subscribeToTrader') || 'Subscribe to Trader', desc: 'Auto-copy trades with custom allocation' },
    { icon: '2', label: t('stopLoss') || 'Stop Loss', desc: 'Set automatic stop-loss protection' },
    { icon: '3', label: t('leverage') || 'Leverage', desc: 'Control maximum leverage per position' },
    { icon: '4', label: t('totalPnl') || 'Total PnL', desc: 'Track realized and unrealized profits' },
  ]

  return (
    <Box
      className={className}
      style={{
        padding: tokens.spacing[5],
        borderRadius: tokens.radius.xl,
        background: `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.tertiary}E8 100%)`,
        border: `1px solid ${tokens.colors.border.primary}`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Decorative gradient */}
      <Box
        style={{
          position: 'absolute',
          top: -50,
          right: -50,
          width: 150,
          height: 150,
          background: `radial-gradient(circle, ${tokens.colors.accent.primary}15 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />

      {/* Header */}
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Box
            style={{
              width: 40,
              height: 40,
              borderRadius: tokens.radius.lg,
              background: `linear-gradient(135deg, ${tokens.colors.accent.primary}20 0%, ${tokens.colors.accent.brand}15 100%)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: tokens.colors.accent.primary,
            }}
          >
            <ChainIcon size={20} />
          </Box>
          <Box>
            <Text size="md" weight="bold">
              {t('onChainCopyTrading') || 'On-Chain Copy Trading'}
            </Text>
            <Text size="xs" color="tertiary">
              {t('onChainCopyTradingDesc') || 'Automatically copy trading strategies via smart contracts'}
            </Text>
          </Box>
        </Box>

        {isConnected && <ChainIndicator size="sm" showName={false} />}
      </Box>

      {/* Coming Soon Content */}
      {!isAvailable && (
        <Box
          style={{
            padding: tokens.spacing[5],
            borderRadius: tokens.radius.lg,
            background: `linear-gradient(135deg, var(--color-accent-primary-08) 0%, var(--color-accent-primary-08) 100%)`,
            border: `1px dashed ${tokens.colors.accent.primary}40`,
            textAlign: 'center',
          }}
        >
          {/* Coming Soon Badge */}
          <Box
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.full,
              background: `linear-gradient(135deg, ${tokens.colors.accent.primary} 0%, ${tokens.colors.accent.brand} 100%)`,
              marginBottom: tokens.spacing[4],
            }}
          >
            <RocketIcon size={16} />
            <Text size="sm" weight="bold" style={{ color: tokens.colors.white }}>
              {t('onChainCopyTradingComingSoon') || 'Coming Soon'}
            </Text>
          </Box>

          <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[5], lineHeight: 1.6 }}>
            {t('onChainCopyTradingComingSoonDesc') || 'On-chain copy trading is under development. Stay tuned!'}
          </Text>

          {/* Feature Preview */}
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: tokens.spacing[3],
              textAlign: 'left',
            }}
          >
            {upcomingFeatures.map((feature, i) => (
              <Box
                key={i}
                style={{
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: 4 }}>
                  <Box
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: tokens.radius.full,
                      background: `${tokens.colors.accent.primary}20`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      fontWeight: 700,
                      color: tokens.colors.accent.primary,
                    }}
                  >
                    {feature.icon}
                  </Box>
                  <Text size="xs" weight="bold">
                    {feature.label}
                  </Text>
                </Box>
                <Text size="xs" color="tertiary" style={{ lineHeight: 1.4 }}>
                  {feature.desc}
                </Text>
              </Box>
            ))}
          </Box>

          {/* Notify Button */}
          <Button
            variant="ghost"
            size="sm"
            style={{
              marginTop: tokens.spacing[4],
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.accent.primary}40`,
              background: 'transparent',
              color: tokens.colors.accent.primary,
              fontWeight: 600,
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
            }}
            onClick={() => {
              showToast(t('onChainCopyTradingComingSoon') || 'Coming soon!', 'info')
            }}
          >
            Notify Me When Available
          </Button>
        </Box>
      )}

      {/* Active Copy Trading UI (when contracts are deployed) */}
      {isAvailable && (
        <Box style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
          <Text size="sm" color="secondary">
            Copy trading for <strong>{traderHandle}</strong> is available.
          </Text>
        </Box>
      )}
    </Box>
  )
}

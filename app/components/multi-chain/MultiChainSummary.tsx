'use client'

import { tokens } from '@/lib/design-tokens'
import type { ChainData } from './ChainPortfolio'

interface MultiChainSummaryProps {
  address: string
  addressType: 'evm' | 'solana'
  chains: ChainData[]
  summary: {
    totalChains: number
    chainsWithBalance: number
    totalTokenTypes: number
  }
}

export default function MultiChainSummary({ address, addressType, chains, summary }: MultiChainSummaryProps) {
  const activeChains = chains.filter(
    (c) => !c.error && (parseFloat(c.nativeBalance) > 0 || c.tokens.length > 0)
  )

  return (
    <div style={{
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.lg,
      border: `1px solid ${tokens.colors.border.primary}`,
      padding: tokens.spacing[5],
      marginBottom: tokens.spacing[4],
    }}>
      {/* Address */}
      <div style={{ marginBottom: tokens.spacing[3] }}>
        <span style={{
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.xs,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          {addressType === 'evm' ? 'EVM Address' : 'Solana Address'}
        </span>
        <div style={{
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.sm,
          fontFamily: 'monospace',
          marginTop: tokens.spacing[1],
          wordBreak: 'break-all',
        }}>
          {address}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: tokens.spacing[6], flexWrap: 'wrap' }}>
        <StatItem label="Chains Queried" value={String(summary.totalChains)} />
        <StatItem label="Active Chains" value={String(summary.chainsWithBalance)} />
        <StatItem label="Token Types" value={String(summary.totalTokenTypes)} />
        <StatItem
          label="Native Balances"
          value={activeChains.map((c) => `${formatShort(c.nativeBalance)} ${c.nativeSymbol}`).join(', ') || 'None'}
          mono
        />
      </div>
    </div>
  )
}

function StatItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{
        color: tokens.colors.text.tertiary,
        fontSize: tokens.typography.fontSize.xs,
        marginBottom: '2px',
      }}>
        {label}
      </div>
      <div style={{
        color: tokens.colors.text.primary,
        fontSize: mono ? tokens.typography.fontSize.xs : tokens.typography.fontSize.base,
        fontWeight: 600,
        fontFamily: mono ? 'monospace' : 'inherit',
      }}>
        {value}
      </div>
    </div>
  )
}

function formatShort(value: string): string {
  const num = parseFloat(value)
  if (isNaN(num) || num === 0) return '0'
  if (num < 0.01) return '<0.01'
  if (num < 1000) return num.toFixed(2)
  return (num / 1000).toFixed(1) + 'K'
}

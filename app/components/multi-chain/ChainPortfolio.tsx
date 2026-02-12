'use client'

import { tokens } from '@/lib/design-tokens'

interface TokenInfo {
  symbol: string
  name: string
  balance: string
  contractAddress: string
}

export interface ChainData {
  chain: string
  chainId: number | null
  nativeBalance: string
  nativeSymbol: string
  tokens: TokenInfo[]
  error?: string
}

const CHAIN_ICONS: Record<string, string> = {
  ethereum: '⟠',
  base: '🔵',
  arbitrum: '🔷',
  optimism: '🔴',
  solana: '◎',
}

const CHAIN_COLORS: Record<string, string> = {
  ethereum: '#627EEA',
  base: '#0052FF',
  arbitrum: '#28A0F0',
  optimism: '#FF0420',
  solana: '#9945FF',
}

interface ChainPortfolioProps {
  data: ChainData
}

export default function ChainPortfolio({ data }: ChainPortfolioProps) {
  const icon = CHAIN_ICONS[data.chain] || '🔗'
  const color = CHAIN_COLORS[data.chain] || 'var(--color-accent-primary)'
  const hasAssets = parseFloat(data.nativeBalance) > 0 || data.tokens.length > 0

  return (
    <div
      style={{
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        padding: tokens.spacing[4],
        borderTop: `3px solid ${color}`,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
        <span style={{ fontSize: '20px' }}>{icon}</span>
        <h3 style={{
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.base,
          fontWeight: 600,
          margin: 0,
          textTransform: 'capitalize',
        }}>
          {data.chain}
        </h3>
        {data.error && (
          <span style={{
            fontSize: tokens.typography.fontSize.xs,
            color: 'var(--color-accent-warning, #FFB800)',
            marginLeft: 'auto',
          }}>
            ⚠ Error
          </span>
        )}
      </div>

      {data.error ? (
        <div style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}>
          {data.error}
        </div>
      ) : !hasAssets ? (
        <div style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.sm }}>
          No assets found
        </div>
      ) : (
        <>
          {/* Native balance */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: tokens.spacing[3],
            paddingBottom: tokens.spacing[2],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}>
            <span style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.sm }}>
              {data.nativeSymbol}
            </span>
            <span style={{
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              fontWeight: 600,
              fontFamily: 'monospace',
            }}>
              {formatBalance(data.nativeBalance)}
            </span>
          </div>

          {/* Token list */}
          {data.tokens.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
              {data.tokens.slice(0, 8).map((token) => (
                <div
                  key={token.contractAddress}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: `${tokens.spacing[1]} 0`,
                  }}
                >
                  <span style={{
                    color: tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.xs,
                    maxWidth: '120px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {token.symbol}
                  </span>
                  <span style={{
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.xs,
                    fontFamily: 'monospace',
                  }}>
                    {formatBalance(token.balance)}
                  </span>
                </div>
              ))}
              {data.tokens.length > 8 && (
                <span style={{
                  color: tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.xs,
                  textAlign: 'center',
                  paddingTop: tokens.spacing[1],
                }}>
                  +{data.tokens.length - 8} more tokens
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function formatBalance(value: string): string {
  const num = parseFloat(value)
  if (isNaN(num)) return '0'
  if (num === 0) return '0'
  if (num < 0.0001) return '<0.0001'
  if (num < 1) return num.toFixed(4)
  if (num < 1000) return num.toFixed(2)
  if (num < 1_000_000) return (num / 1000).toFixed(2) + 'K'
  return (num / 1_000_000).toFixed(2) + 'M'
}

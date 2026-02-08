'use client'

import { useState, useEffect, useCallback } from 'react'
import { t } from '@/lib/i18n'
import { tokens } from '@/lib/design-tokens'

interface WalletBalanceData {
  nativeBalance: string
  nativeSymbol: string
  chainName: string
  nativeBalanceRaw: string
}

interface TokenData {
  symbol: string
  name: string
  balance: string
  contractAddress: string
}

interface TransactionData {
  hash: string
  blockNumber: string
  from: string
  to: string | null
  value: string
  gasUsed: string | null
  timestamp: number | null
  status: 'success' | 'reverted' | 'unknown'
}

interface WalletResponse {
  balance: WalletBalanceData
  tokens: TokenData[]
  transactions: TransactionData[]
}

const CHAIN_OPTIONS = [
  { id: 1, name: 'Ethereum' },
  { id: 56, name: 'BNB Smart Chain' },
  { id: 42161, name: 'Arbitrum One' },
  { id: 137, name: 'Polygon' },
  { id: 8453, name: 'Base' },
  { id: 10, name: 'Optimism' },
]

interface WalletOverviewProps {
  address: string
  defaultChainId?: number
}

export default function WalletOverview({ address, defaultChainId = 1 }: WalletOverviewProps) {
  const [chainId, setChainId] = useState(defaultChainId)
  const [data, setData] = useState<WalletResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/wallet/${address}?chainId=${chainId}`)
      if (!res.ok) throw new Error('Failed to fetch wallet data')
      const json = await res.json()
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [address, chainId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const formatHash = (hash: string) => `${hash.slice(0, 8)}...${hash.slice(-6)}`
  const formatTimestamp = (ts: number | null) =>
    ts ? new Date(ts * 1000).toLocaleString() : '--'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.lg }}>
      {/* Chain Selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm }}>
        <label style={{ color: tokens.colors.textSecondary, fontSize: tokens.fontSizes.sm }}>
          {t('chainName')}:
        </label>
        <select
          value={chainId}
          onChange={(e) => setChainId(Number(e.target.value))}
          style={{
            background: tokens.colors.surface,
            color: tokens.colors.text,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            padding: `${tokens.spacing.xs} ${tokens.spacing.sm}`,
            fontSize: tokens.fontSizes.sm,
          }}
        >
          {CHAIN_OPTIONS.map((chain) => (
            <option key={chain.id} value={chain.id}>
              {chain.name}
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <div style={{ color: tokens.colors.textSecondary, padding: tokens.spacing.lg }}>
          {t('loading')}
        </div>
      )}

      {error && (
        <div style={{ color: tokens.colors.negative, padding: tokens.spacing.md }}>
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Native Balance */}
          <section>
            <h3 style={{ color: tokens.colors.text, fontSize: tokens.fontSizes.lg, marginBottom: tokens.spacing.sm }}>
              {t('walletBalance')}
            </h3>
            <div
              style={{
                background: tokens.colors.surface,
                borderRadius: tokens.radii.lg,
                padding: tokens.spacing.lg,
                border: `1px solid ${tokens.colors.border}`,
              }}
            >
              <div style={{ fontSize: tokens.fontSizes.xl, fontWeight: 600, color: tokens.colors.text }}>
                {parseFloat(data.balance.nativeBalance).toFixed(6)} {data.balance.nativeSymbol}
              </div>
              <div style={{ fontSize: tokens.fontSizes.sm, color: tokens.colors.textSecondary, marginTop: tokens.spacing.xs }}>
                {data.balance.chainName}
              </div>
            </div>
          </section>

          {/* Token Holdings */}
          {data.tokens.length > 0 && (
            <section>
              <h3 style={{ color: tokens.colors.text, fontSize: tokens.fontSizes.lg, marginBottom: tokens.spacing.sm }}>
                {t('tokenHoldings')}
              </h3>
              <div
                style={{
                  background: tokens.colors.surface,
                  borderRadius: tokens.radii.lg,
                  border: `1px solid ${tokens.colors.border}`,
                  overflow: 'hidden',
                }}
              >
                {data.tokens.map((token) => (
                  <div
                    key={token.contractAddress}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: `${tokens.spacing.md} ${tokens.spacing.lg}`,
                      borderBottom: `1px solid ${tokens.colors.border}`,
                    }}
                  >
                    <div>
                      <div style={{ color: tokens.colors.text, fontWeight: 500 }}>{token.symbol}</div>
                      <div style={{ color: tokens.colors.textSecondary, fontSize: tokens.fontSizes.xs }}>{token.name}</div>
                    </div>
                    <div style={{ color: tokens.colors.text, fontFamily: 'monospace' }}>
                      {parseFloat(token.balance).toFixed(4)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Recent Transactions */}
          {data.transactions.length > 0 && (
            <section>
              <h3 style={{ color: tokens.colors.text, fontSize: tokens.fontSizes.lg, marginBottom: tokens.spacing.sm }}>
                {t('recentTransactions')}
              </h3>
              <div
                style={{
                  background: tokens.colors.surface,
                  borderRadius: tokens.radii.lg,
                  border: `1px solid ${tokens.colors.border}`,
                  overflow: 'hidden',
                }}
              >
                {data.transactions.map((tx) => (
                  <div
                    key={tx.hash}
                    style={{
                      padding: `${tokens.spacing.md} ${tokens.spacing.lg}`,
                      borderBottom: `1px solid ${tokens.colors.border}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing.xs }}>
                      <div style={{ fontFamily: 'monospace', fontSize: tokens.fontSizes.sm, color: tokens.colors.accent }}>
                        {formatHash(tx.hash)}
                      </div>
                      <div
                        style={{
                          fontSize: tokens.fontSizes.xs,
                          color: tx.status === 'success' ? tokens.colors.positive : tx.status === 'reverted' ? tokens.colors.negative : tokens.colors.textSecondary,
                        }}
                      >
                        {tx.status}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: tokens.fontSizes.xs, color: tokens.colors.textSecondary }}>
                      <span>{t('blockNumber')}: {tx.blockNumber}</span>
                      <span>{formatTimestamp(tx.timestamp)}</span>
                    </div>
                    <div style={{ fontSize: tokens.fontSizes.sm, color: tokens.colors.text, marginTop: tokens.spacing.xs }}>
                      {tx.value} {data.balance.nativeSymbol}
                      {tx.gasUsed && (
                        <span style={{ color: tokens.colors.textSecondary, marginLeft: tokens.spacing.sm, fontSize: tokens.fontSizes.xs }}>
                          {t('gasUsed')}: {tx.gasUsed}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

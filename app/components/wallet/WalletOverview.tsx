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
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {/* Chain Selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        <label style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.sm }}>
          {t('chainName')}:
        </label>
        <select
          value={chainId}
          onChange={(e) => setChainId(Number(e.target.value))}
          style={{
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.primary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            fontSize: tokens.typography.fontSize.sm,
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
        <div style={{ color: tokens.colors.text.secondary, padding: tokens.spacing[4] }}>
          {t('loading')}
        </div>
      )}

      {error && (
        <div style={{ color: tokens.colors.accent.error, padding: tokens.spacing[3] }}>
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Native Balance */}
          <section>
            <h3 style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.lg, marginBottom: tokens.spacing[2] }}>
              {t('walletBalance')}
            </h3>
            <div
              style={{
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                padding: tokens.spacing[4],
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <div style={{ fontSize: tokens.typography.fontSize.xl, fontWeight: 600, color: tokens.colors.text.primary }}>
                {parseFloat(data.balance.nativeBalance).toFixed(6)} {data.balance.nativeSymbol}
              </div>
              <div style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary, marginTop: tokens.spacing[1] }}>
                {data.balance.chainName}
              </div>
            </div>
          </section>

          {/* Token Holdings */}
          {data.tokens.length > 0 && (
            <section>
              <h3 style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.lg, marginBottom: tokens.spacing[2] }}>
                {t('tokenHoldings')}
              </h3>
              <div
                style={{
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
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
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <div>
                      <div style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>{token.symbol}</div>
                      <div style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs }}>{token.name}</div>
                    </div>
                    <div style={{ color: tokens.colors.text.primary, fontFamily: 'monospace' }}>
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
              <h3 style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.lg, marginBottom: tokens.spacing[2] }}>
                {t('recentTransactions')}
              </h3>
              <div
                style={{
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  overflow: 'hidden',
                }}
              >
                {data.transactions.map((tx) => (
                  <div
                    key={tx.hash}
                    style={{
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[1] }}>
                      <div style={{ fontFamily: 'monospace', fontSize: tokens.typography.fontSize.sm, color: tokens.colors.accent.primary }}>
                        {formatHash(tx.hash)}
                      </div>
                      <div
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          color: tx.status === 'success'
                            ? tokens.colors.accent.success
                            : tx.status === 'reverted'
                              ? tokens.colors.accent.error
                              : tokens.colors.text.secondary,
                        }}
                      >
                        {tx.status}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary }}>
                      <span>{t('blockNumber')}: {tx.blockNumber}</span>
                      <span>{formatTimestamp(tx.timestamp)}</span>
                    </div>
                    <div style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.primary, marginTop: tokens.spacing[1] }}>
                      {tx.value} {data.balance.nativeSymbol}
                      {tx.gasUsed && (
                        <span style={{ color: tokens.colors.text.secondary, marginLeft: tokens.spacing[2], fontSize: tokens.typography.fontSize.xs }}>
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

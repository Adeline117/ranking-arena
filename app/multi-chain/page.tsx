'use client'

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import AddressInput from '@/app/components/multi-chain/AddressInput'
import ChainPortfolio, { type ChainData } from '@/app/components/multi-chain/ChainPortfolio'
import MultiChainSummary from '@/app/components/multi-chain/MultiChainSummary'

interface MultiChainResponse {
  address: string
  addressType: 'evm' | 'solana'
  queriedChains: string[]
  summary: {
    totalChains: number
    chainsWithBalance: number
    totalTokenTypes: number
  }
  chains: ChainData[]
}

export default function MultiChainPage() {
  const [data, setData] = useState<MultiChainResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastAddress, setLastAddress] = useState<string | null>(null)

  const handleAnalyze = useCallback(async (address: string) => {
    setIsLoading(true)
    setError(null)
    setData(null)
    setLastAddress(address)

    try {
      const res = await fetch(`/api/multi-chain/${encodeURIComponent(address)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const json: MultiChainResponse = await res.json()
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze address')
    } finally {
      setIsLoading(false)
    }
  }, [])

  return (
    <div style={{
      maxWidth: '960px',
      margin: '0 auto',
      padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
    }}>
      {/* Header */}
      <div style={{ marginBottom: tokens.spacing[6] }}>
        <h1 style={{
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize['2xl'],
          fontWeight: 700,
          margin: 0,
          marginBottom: tokens.spacing[2],
        }}>
          Multi-Chain Asset Analysis
        </h1>
        <p style={{
          color: tokens.colors.text.secondary,
          fontSize: tokens.typography.fontSize.sm,
          margin: 0,
        }}>
          Analyze wallet holdings across Solana, Base, Arbitrum, Optimism, and Ethereum.
        </p>
      </div>

      {/* Address Input */}
      <div style={{ marginBottom: tokens.spacing[6] }}>
        <AddressInput onSubmit={handleAnalyze} isLoading={isLoading} />
      </div>

      {/* Loading */}
      {isLoading && (
        <div style={{
          textAlign: 'center',
          padding: tokens.spacing[8],
          color: tokens.colors.text.secondary,
        }}>
          <div style={{ fontSize: '24px', marginBottom: tokens.spacing[2] }}>⏳</div>
          Querying chains...
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          background: 'rgba(255,0,0,0.1)',
          border: '1px solid var(--color-accent-error)',
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing[4],
          color: 'var(--color-accent-error)',
          fontSize: tokens.typography.fontSize.sm,
          marginBottom: tokens.spacing[4],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[3],
        }}>
          <span>{error}</span>
          {lastAddress && (
            <button
              onClick={() => handleAnalyze(lastAddress)}
              style={{
                padding: '6px 16px',
                borderRadius: 8,
                border: '1px solid var(--color-accent-error)',
                background: 'transparent',
                color: 'var(--color-accent-error)',
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Results */}
      {data && (
        <>
          <MultiChainSummary
            address={data.address}
            addressType={data.addressType}
            chains={data.chains}
            summary={data.summary}
          />

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: tokens.spacing[4],
          }}>
            {data.chains.map((chain) => (
              <ChainPortfolio key={chain.chain} data={chain} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

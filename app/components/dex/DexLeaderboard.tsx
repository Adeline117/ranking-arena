'use client'

import { useEffect, useState } from 'react'
import { t } from '@/lib/i18n'
import type { DexTrader } from '@/lib/web3/dex-tracker'

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function explorerUrl(trader: DexTrader): string {
  return trader.chain === 'bsc'
    ? `https://bscscan.com/address/${trader.address}`
    : `https://etherscan.io/address/${trader.address}`
}

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

const CHAIN_LABELS: Record<string, string> = {
  ethereum: 'ETH',
  bsc: 'BSC',
}

type SortField = 'volume' | 'txCount' | 'pnl'

export default function DexLeaderboard() {
  const [traders, setTraders] = useState<DexTrader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dex, setDex] = useState<string>('')
  const [sortBy, setSortBy] = useState<SortField>('volume')

  useEffect(() => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (dex) params.set('dex', dex)
    params.set('sortBy', sortBy)
    fetch(`/api/dex/traders?${params}`)
      .then((r) => r.json())
      .then((data) => setTraders(data.traders ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [dex, sortBy])

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">{t('dexLeaderboard')}</h2>

      <div className="flex gap-2 mb-4">
        <select
          value={dex}
          onChange={(e) => setDex(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="">All DEX</option>
          <option value="uniswap">Uniswap</option>
          <option value="pancakeswap">PancakeSwap</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortField)}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="volume">{t('onChainVolume')}</option>
          <option value="txCount">{t('swapCount')}</option>
          <option value="pnl">{t('estimatedPnl')}</option>
        </select>
      </div>

      {loading && <p>{t('loading')}</p>}
      {error && <p className="text-red-500">{error}</p>}

      {!loading && !error && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-4">#</th>
                <th className="py-2 pr-4">{t('walletAddress')}</th>
                <th className="py-2 pr-4">Chain</th>
                <th className="py-2 pr-4">DEX</th>
                <th className="py-2 pr-4 text-right">{t('onChainVolume')}</th>
                <th className="py-2 pr-4 text-right">{t('swapCount')}</th>
                <th className="py-2 text-right">{t('estimatedPnl')}</th>
              </tr>
            </thead>
            <tbody>
              {traders.map((trader, i) => (
                <tr key={`${trader.address}-${trader.dex}`} className="border-b">
                  <td className="py-2 pr-4">{i + 1}</td>
                  <td className="py-2 pr-4">
                    <a
                      href={explorerUrl(trader)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                      title={t('viewOnExplorer')}
                    >
                      {shortenAddress(trader.address)}
                    </a>
                  </td>
                  <td className="py-2 pr-4">{CHAIN_LABELS[trader.chain] ?? trader.chain}</td>
                  <td className="py-2 pr-4 capitalize">{trader.dex}</td>
                  <td className="py-2 pr-4 text-right">{formatUSD(trader.totalVolumeUSD)}</td>
                  <td className="py-2 pr-4 text-right">{trader.txCount.toLocaleString()}</td>
                  <td className="py-2 text-right">{formatUSD(trader.profitEstimate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {traders.length === 0 && (
            <p className="text-center py-4 text-gray-500">{t('noResults')}</p>
          )}
        </div>
      )}
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import MarketTable, { Column } from './MarketTable'

interface FuturesRow {
  symbol: string
  contract: string
  price: number | null
  change24h: number | null
  volume24h: number | null
  image: string | null
  fundingRate: number | null
  openInterest: number | null
  predictedFunding: number | null
  platforms: Record<string, any>
}

function formatNum(n: number | null): string {
  if (n == null) return '--'
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(2)}`
}

function formatRate(r: number | null): string {
  if (r == null) return '--'
  return `${(r * 100).toFixed(4)}%`
}

function RateCell({ value }: { value: number | null }) {
  if (value == null) return <span>--</span>
  const color = value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  return <span style={{ color, fontWeight: 500, fontFamily: tokens.typography.fontFamily.mono.join(',') }}>{formatRate(value)}</span>
}

function ChangeCell({ value }: { value: number | null }) {
  if (value == null) return <span>--</span>
  const color = value >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  return <span style={{ color, fontWeight: 500 }}>{value >= 0 ? '+' : ''}{value.toFixed(2)}%</span>
}

export default function FuturesMarket() {
  const { t } = useLanguage()
  const [data, setData] = useState<FuturesRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/market/futures')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setData(d) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const columns: Column<FuturesRow>[] = [
    {
      key: 'contract',
      label: t('contract') || '合约',
      align: 'left',
      sortable: true,
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {r.image && <img src={r.image} alt={`${r.symbol || r.contract || 'Token'} icon`} width={20} height={20} style={{ borderRadius: '50%' }} loading="lazy" />}
          <span style={{ fontWeight: 600 }}>{r.contract}</span>
          <span style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.xs }}>永续</span>
        </span>
      ),
      getValue: (r) => r.symbol,
    },
    {
      key: 'price',
      label: t('lastPrice') || '最新价',
      sortable: true,
      render: (r) => (
        <span style={{ fontFamily: tokens.typography.fontFamily.mono.join(',') }}>
          {r.price != null ? `$${r.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'}
        </span>
      ),
    },
    {
      key: 'change24h',
      label: t('change24h') || '24h涨跌',
      sortable: true,
      render: (r) => <ChangeCell value={r.change24h} />,
    },
    {
      key: 'fundingRate',
      label: t('fundingRate') || '资金费率',
      sortable: true,
      render: (r) => <RateCell value={r.fundingRate} />,
    },
    {
      key: 'openInterest',
      label: t('openInterest') || '未平仓量',
      sortable: true,
      render: (r) => <span>{formatNum(r.openInterest)}</span>,
    },
    {
      key: 'volume24h',
      label: t('volume24h') || '24h成交量',
      sortable: true,
      render: (r) => <span>{formatNum(r.volume24h)}</span>,
    },
    {
      key: 'predictedFunding',
      label: t('predictedFunding') || '预测资金费率',
      sortable: true,
      render: (r) => <RateCell value={r.predictedFunding} />,
    },
  ]

  return (
    <MarketTable
      columns={columns}
      data={data}
      loading={loading}
      defaultSortKey="openInterest"
      defaultSortDir="desc"
      rowKey={(r) => r.contract}
    />
  )
}

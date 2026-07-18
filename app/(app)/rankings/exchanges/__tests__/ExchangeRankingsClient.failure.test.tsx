import { fireEvent, render, screen } from '@testing-library/react'
import ExchangeRankingsClient from '../ExchangeRankingsClient'
import type {
  ExchangeRankingRow,
  ExchangeRankings,
  ExchangeRankingsTimeframe,
} from '@/lib/data/serving/exchange-rankings'

const mockRefresh = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    refresh: mockRefresh,
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => key,
  }),
}))

const row: ExchangeRankingRow = {
  source: 'hyperliquid',
  exchangeSlug: 'hyperliquid',
  exchangeName: 'Hyperliquid',
  productType: 'onchain',
  currency: 'USDC',
  rankedTraders: 20,
  medianRoi: 12,
  topDecileRoi: 42,
  pctProfitable: 60,
  copierPnl: null,
  botShare: 5,
  provenance: {
    source: 'hyperliquid',
    asOf: '2026-07-18T12:00:00.000Z',
    derived: false,
  },
}

function result(
  timeframe: ExchangeRankingsTimeframe,
  rows: ExchangeRankingRow[] = []
): ExchangeRankings {
  return {
    nonLegacyCount: 5,
    timeframe,
    rows,
  }
}

describe('ExchangeRankingsClient failure states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows a retryable error instead of empty copy for a failed timeframe', () => {
    render(
      <ExchangeRankingsClient
        byTimeframe={{ 7: result(7), 30: result(30), 90: null }}
        failedTimeframes={[90]}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('failedToLoadRankings')
    expect(screen.queryByText('exchangeRankingsEmpty')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('keeps successful rows visible and labels a partial result', () => {
    render(
      <ExchangeRankingsClient
        byTimeframe={{ 7: null, 30: result(30), 90: result(90, [row]) }}
        failedTimeframes={[7]}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('dataLoadIncomplete')
    expect(screen.getByRole('link', { name: 'Hyperliquid' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders genuine successful emptiness without an error state', () => {
    render(
      <ExchangeRankingsClient byTimeframe={{ 7: result(7), 30: result(30), 90: result(90) }} />
    )

    expect(screen.getByText('exchangeRankingsEmpty')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

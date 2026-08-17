import { render, screen } from '@testing-library/react'
import PositionHistoryCard from '../PositionHistoryCard'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/common/CryptoIcon', () => ({
  __esModule: true,
  default: function MockCryptoIcon() {
    return <span data-testid="crypto-icon" />
  },
}))

const position = {
  symbol: 'ETHUSDT',
  direction: 'short' as const,
  entryPrice: 100,
  exitPrice: 90,
  pnlPct: 10,
  openTime: '2026-08-01T00:00:00.000Z',
  closeTime: '2026-08-02T00:00:00.000Z',
  positionType: 'perpetual',
  marginMode: 'isolated',
  maxPositionSize: 10,
  closedSize: 1,
  pnlUsd: -10,
  status: 'closed',
}

describe('PositionHistoryCard currency-bound PnL', () => {
  it('keeps a portfolio history PnL in its exact serving unit', () => {
    render(<PositionHistoryCard position={{ ...position, pnlCurrency: 'USDT' }} index={0} />)

    expect(screen.getByText('-$10.00 USDT')).toBeInTheDocument()
  })

  it('hides an unbound absolute PnL instead of relabeling it as dollars', () => {
    render(<PositionHistoryCard position={{ ...position, pnlCurrency: null }} index={0} />)

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/\$10/)).not.toBeInTheDocument()
  })
})

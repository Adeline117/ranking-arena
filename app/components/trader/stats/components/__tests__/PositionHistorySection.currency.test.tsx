import { render, screen } from '@testing-library/react'
import { PositionHistorySection } from '../PositionHistorySection'

jest.mock('@/app/components/common/CryptoIcon', () => ({
  __esModule: true,
  default: function MockCryptoIcon() {
    return <span data-testid="crypto-icon" />
  },
}))

const position = {
  symbol: 'BTCUSDC',
  direction: 'long',
  positionType: 'perpetual',
  marginMode: 'isolated',
  openTime: '2026-08-01T00:00:00.000Z',
  closeTime: '2026-08-02T00:00:00.000Z',
  entryPrice: 100,
  exitPrice: 110,
  maxPositionSize: 10,
  closedSize: 1,
  pnlUsd: 100,
  pnlPct: 10,
  status: 'closed',
}

describe('PositionHistorySection currency-bound PnL', () => {
  it('preserves the legacy USD formatter when no serving unit contract exists', () => {
    render(<PositionHistorySection positionHistory={[position]} t={(key) => key} />)

    expect(screen.getByText('+$100.00')).toBeInTheDocument()
  })

  it('renders a serving position PnL with its actual source unit', () => {
    render(
      <PositionHistorySection
        positionHistory={[{ ...position, pnlCurrency: 'USDC' }]}
        t={(key) => key}
      />
    )

    expect(screen.getByText('+$100.00 USDC')).toBeInTheDocument()
  })

  it('does not invent a dollar unit for an unbound serving PnL', () => {
    render(
      <PositionHistorySection
        positionHistory={[{ ...position, pnlCurrency: null }]}
        t={(key) => key}
      />
    )

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('+$100.00')).not.toBeInTheDocument()
  })
})

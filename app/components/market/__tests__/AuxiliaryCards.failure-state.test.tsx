import { fireEvent, render, screen } from '@testing-library/react'
import { apiFetch } from '@/lib/utils/api-fetch'
import ArbitrageOpportunities from '../ArbitrageOpportunities'
import FearGreedGauge from '../FearGreedGauge'

jest.mock('@/lib/utils/api-fetch', () => ({
  apiFetch: jest.fn(),
}))

const mockTranslations: Record<string, string> = {
  marketDataError: 'Market data failed to load',
  loadFailedRetryShort: 'Failed to load, please retry',
  retry: 'Retry',
  noDataGeneric: 'No data available',
  arbitrageOpportunities: 'Arbitrage',
  arbitrageOppsCount: '{n} opportunities',
  arbitrageEquilibrium: 'Markets are aligned',
  arbitrageNoOpps: 'No actionable spread',
}
const mockTranslate = (key: string) => mockTranslations[key] ?? key

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: mockTranslate,
  }),
}))

const mockedApiFetch = jest.mocked(apiFetch)

describe('auxiliary market card failure states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not turn an arbitrage request failure into a false no-opportunity claim', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({ ok: true, opportunities: [] })

    const view = render(<ArbitrageOpportunities />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Market data failed to load')
    expect(screen.queryByText('Markets are aligned')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Markets are aligned')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ends a failed Fear and Greed load with retry, then renders a genuine empty response', async () => {
    mockedApiFetch
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({ current: undefined, history: [] })

    const view = render(<FearGreedGauge />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Market data failed to load')
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('status')).toHaveTextContent('No data available')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

import { render, screen } from '@testing-library/react'
import { apiFetch } from '@/lib/utils/api-fetch'
import ArbitrageOpportunities from '../ArbitrageOpportunities'
import FearGreedGauge from '../FearGreedGauge'

jest.mock('@/lib/utils/api-fetch', () => ({
  apiFetch: jest.fn(),
}))

const mockTranslations: Record<string, string> = {
  arbitrageOpportunities: 'Arbitrage',
  fearGreedTitle: 'Fear & Greed',
  dataUnavailable: 'Unavailable',
}
const mockTranslate = (key: string) => mockTranslations[key] ?? key

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: mockTranslate,
  }),
}))

const mockedApiFetch = jest.mocked(apiFetch)

describe('auxiliary market card state contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders a local unavailable arbitrage card without requesting data', () => {
    const view = render(<ArbitrageOpportunities />)

    expect(screen.getByText('Arbitrage')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(mockedApiFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })

  it('renders a local unavailable Fear & Greed card without requesting data', () => {
    const view = render(<FearGreedGauge />)

    expect(screen.getByText('Fear & Greed')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(mockedApiFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })
})

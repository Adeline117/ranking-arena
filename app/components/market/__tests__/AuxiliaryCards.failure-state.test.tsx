import { render, screen } from '@testing-library/react'
import { apiFetch } from '@/lib/utils/api-fetch'
import ArbitrageOpportunities from '../ArbitrageOpportunities'
import DefiOverview from '../DefiOverview'
import ExchangeVolume from '../ExchangeVolume'
import FearGreedGauge from '../FearGreedGauge'
import SectorPerformance from '../SectorPerformance'

jest.mock('@/lib/utils/api-fetch', () => ({
  apiFetch: jest.fn(),
}))

const mockTranslations: Record<string, string> = {
  arbitrageOpportunities: 'Arbitrage',
  defiOverview: 'DeFi Overview',
  exchangeVolume: 'Exchange Volume',
  fearGreedTitle: 'Fear & Greed',
  sectorPerformance: 'Sector Performance',
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

  it('renders a local unavailable DeFi card without requesting data', () => {
    const view = render(<DefiOverview />)

    expect(screen.getByText('DeFi Overview')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(mockedApiFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })

  it('renders a local unavailable exchange-volume card without requesting data', () => {
    const view = render(<ExchangeVolume />)

    expect(screen.getByText('Exchange Volume')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(mockedApiFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })

  it('renders a local unavailable sector card without requesting data', () => {
    const view = render(<SectorPerformance />)

    expect(screen.getByText('Sector Performance')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(mockedApiFetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })
})

import { render, screen } from '@testing-library/react'
import { apiFetch } from '@/lib/utils/api-fetch'
import TokenSidePanel from '../TokenSidePanel'

jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))

jest.mock('@/lib/utils/api-fetch', () => ({
  apiFetch: jest.fn(),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          dataUnavailable: 'Data unavailable',
          loading: 'Loading',
          chartUnavailable: 'Chart unavailable',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

const mockedApiFetch = jest.mocked(apiFetch)

const bitcoin = {
  id: 'bitcoin',
  symbol: 'BTC',
  name: 'Bitcoin',
  image: '',
  price: 100_000,
  change24h: 2.5,
  marketCap: 2_000_000_000_000,
  volume24h: 50_000_000_000,
  high24h: 101_000,
  low24h: 98_000,
  rank: 1,
}

describe('TokenSidePanel retired public-egress acquisition', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders local unavailable data without any retired coin-detail or OHLC request', () => {
    render(<TokenSidePanel token={bitcoin} onClose={jest.fn()} />)

    expect(mockedApiFetch).not.toHaveBeenCalled()
    expect(mockedApiFetch).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/market\/coin\//))
    expect(mockedApiFetch).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/market\/ohlc\//))
    expect(screen.getByRole('status')).toHaveTextContent('Data unavailable')
  })
})

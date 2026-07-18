import { fireEvent, render, screen } from '@testing-library/react'
import { useMarketFeed } from '@/lib/hooks/useMarketFeed'
import LiveTradesFeed from '../LiveTradesFeed'

jest.mock('@/lib/hooks/useMarketFeed', () => ({
  useMarketFeed: jest.fn(),
}))

const mockTranslations: Record<string, string> = {
  disconnected: 'Disconnected',
  connectionLostMessage: 'Connection lost',
  retryConnection: 'Retry connection',
}
const mockTranslate = (key: string) => mockTranslations[key] ?? key

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockTranslate }),
}))

const mockedUseMarketFeed = jest.mocked(useMarketFeed)
const retry = jest.fn()

describe('LiveTradesFeed connection failure', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedUseMarketFeed.mockReturnValue({
      trades: [],
      tickers: new Map(),
      connectionStatus: { binance: false, bybit: false, okx: false },
      connected: false,
      error: 'connection_timeout',
      retry,
    })
  })

  it('shows a visible connection error with a working retry action', () => {
    render(<LiveTradesFeed />)

    expect(screen.getByRole('alert')).toHaveTextContent('Disconnected')
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

import { fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import MarketPageClient from '../MarketPageClient'
import { useMarketSpotData } from '@/lib/hooks/useMarketSpot'
import { createMarketSpotSnapshot } from '@/lib/market/market-spot-client-contract'

jest.mock('@/lib/hooks/useMarketSpot', () => ({
  useMarketSpotData: jest.fn(),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => <button type="button">floating</button>,
}))

jest.mock('@/app/components/utils/ErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: ({ title, actions }: { title: string; actions: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
}))

jest.mock('@/app/components/market/PriceTicker', () => ({
  __esModule: true,
  default: () => <div>ticker</div>,
}))
jest.mock('@/app/components/market/GlobalMarketBar', () => ({
  __esModule: true,
  default: () => <div>global-market</div>,
}))
jest.mock('@/app/components/market/FearGreedGauge', () => ({
  __esModule: true,
  default: () => <div>fear-greed</div>,
}))
jest.mock('@/app/components/market/MarketWatchlistEntry', () => ({
  __esModule: true,
  default: () => <div>watchlist</div>,
}))
jest.mock('@/app/components/market/MarketSpotDataGate', () => ({
  __esModule: true,
  default: ({ pending, failed, children }: any) => (
    <div data-testid="spot-gate" data-pending={String(pending)} data-failed={String(failed)}>
      {!pending && !failed ? children : null}
    </div>
  ),
}))
jest.mock('@/app/components/market/CoreCards', () => ({
  __esModule: true,
  default: ({ spotData }: { spotData?: unknown[] }) => (
    <div data-testid="core-cards">core:{spotData?.length ?? 0}</div>
  ),
}))
jest.mock('@/app/components/market/SpotMarket', () => ({
  __esModule: true,
  default: ({ spotData }: { spotData?: unknown[] }) => (
    <div data-testid="spot-market">spot:{spotData?.length ?? 0}</div>
  ),
}))
jest.mock('@/app/components/market/SectorTreemap', () => ({
  __esModule: true,
  default: () => <div>sectors</div>,
}))
jest.mock('@/app/components/market/TokenSidePanel', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/app/components/market/MobileMarketTabs', () => ({
  __esModule: true,
  default: () => <div>mobile-tabs</div>,
}))
jest.mock('@/app/components/market/ArbitrageOpportunities', () => ({
  __esModule: true,
  default: () => <div>arbitrage</div>,
}))
jest.mock('@/app/components/market/LiveTradesFeed', () => ({
  __esModule: true,
  default: () => <div>trades</div>,
}))

const mockedUseMarketSpotData = jest.mocked(useMarketSpotData)
const refetch = jest.fn()

const completeCoin = {
  id: 'bitcoin',
  symbol: 'BTC',
  name: 'Bitcoin',
  image: null,
  price: 100_000,
  change1h: null,
  change24h: 1,
  change7d: null,
  high24h: 101_000,
  low24h: 99_000,
  volume24h: 1_000_000,
  marketCap: 2_000_000,
  rank: 1,
}

function queryResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    error: null,
    refetch,
    ...overrides,
  } as ReturnType<typeof useMarketSpotData>
}

describe('market landing load truth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.matchMedia = jest.fn().mockReturnValue({ matches: false } as MediaQueryList)
    mockedUseMarketSpotData.mockReturnValue(queryResult())
  })

  it('server-renders a reserved responsive geometry instead of guessing a desktop viewport', () => {
    const html = renderToString(<MarketPageClient />)

    expect(html).toContain('market-layout-resolving')
    expect(html).toContain('min-height:70vh')
  })

  it('keeps the landing mounted after an SSR failure and offers a 44px client retry', () => {
    mockedUseMarketSpotData.mockReturnValue(queryResult({ isLoading: true }))

    render(<MarketPageClient initialError />)

    expect(screen.getByRole('heading', { name: 'market' })).toBeInTheDocument()
    const warning = screen.getByTestId('market-spot-degraded')
    const retryButton = within(warning).getByRole('button', { name: 'retry' })
    expect(retryButton).toHaveStyle({ minWidth: '44px', minHeight: '44px' })
    fireEvent.click(retryButton)
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('shows partial coverage explicitly while retaining complete rows', async () => {
    const partial = createMarketSpotSnapshot({
      coins: [completeCoin],
      source: 'coingecko',
      providerLimit: 100,
      collectedAt: '2026-08-03T12:00:00.000Z',
    })
    mockedUseMarketSpotData.mockReturnValue(queryResult({ data: partial }))

    render(<MarketPageClient initialSpotSnapshot={partial} />)

    expect(screen.getByTestId('market-spot-degraded')).toHaveTextContent('dataLoadIncomplete')
    expect(await screen.findByTestId('core-cards')).toHaveTextContent('core:1')
    expect(await screen.findByTestId('spot-market')).toHaveTextContent('spot:1')
  })

  it('retains same-query last-good rows and exposes a refresh error', async () => {
    const lastGood = createMarketSpotSnapshot({
      coins: [completeCoin],
      source: 'coingecko',
      providerLimit: 100,
      collectedAt: '2026-08-03T12:00:00.000Z',
    })
    mockedUseMarketSpotData.mockReturnValue(
      queryResult({ data: lastGood, error: new Error('offline') })
    )

    render(<MarketPageClient initialSpotSnapshot={lastGood} />)

    expect(screen.getByTestId('market-spot-degraded')).toBeInTheDocument()
    expect(await screen.findByTestId('spot-market')).toHaveTextContent('spot:1')
  })

  it('keeps provider-only table rows but marks unsupported sector coverage as failed', async () => {
    const providerOnly = createMarketSpotSnapshot({
      coins: [{ ...completeCoin, marketCap: null }],
      source: 'binance',
      providerLimit: 25,
      collectedAt: '2026-08-03T12:00:00.000Z',
    })
    mockedUseMarketSpotData.mockReturnValue(queryResult({ data: providerOnly }))

    render(<MarketPageClient initialSpotSnapshot={providerOnly} />)

    expect(screen.getByTestId('market-spot-degraded')).toHaveTextContent('dataLoadIncomplete')
    expect(screen.getByTestId('core-cards')).toHaveTextContent('core:1')
    expect(await screen.findByTestId('spot-market')).toHaveTextContent('spot:1')
    const gates = screen.getAllByTestId('spot-gate')
    expect(gates[0]).toHaveAttribute('data-failed', 'false')
    expect(gates[1]).toHaveAttribute('data-failed', 'true')
  })

  it('makes both market sub-route links at least 44px tall', () => {
    render(<MarketPageClient />)

    for (const link of [
      screen.getByRole('link', { name: 'fundingRates' }),
      screen.getByRole('link', { name: 'openInterest' }),
    ]) {
      expect(link).toHaveStyle({ minWidth: '44px', minHeight: '44px' })
    }
  })
})

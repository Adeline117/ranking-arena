import { render, screen } from '@testing-library/react'
import SectorTreemap from '../SectorTreemap'
import SpotMarket from '../SpotMarket'

jest.mock('@/lib/hooks/useRealtimePrices', () => ({
  useRealtimePrices: () => ({ prices: {}, flashes: {} }),
}))

jest.mock('@/lib/utils/api-fetch', () => ({
  apiFetch: jest.fn().mockResolvedValue([]),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          noDataGeneric: 'No data available',
          sectorTreemapLoading: 'Loading market data',
          sectorTreemapTitle: 'Sector performance',
          sectorTreemap1h: '1H',
          sectorTreemap24h: '24H',
          sectorTreemap7d: '7D',
          sectorTreemapBigDrop: 'Big drop',
          sectorTreemapDip: 'Dip',
          sectorTreemapRise: 'Rise',
          sectorTreemapRally: 'Rally',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

describe('spot-data panels successful empty states', () => {
  const originalResizeObserver = global.ResizeObserver

  beforeAll(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  afterAll(() => {
    global.ResizeObserver = originalResizeObserver
  })

  it('renders an empty spot table without falling back to a skeleton', () => {
    const view = render(<SpotMarket spotData={[]} />)

    expect(screen.getByText('No data available')).toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })

  it('renders an empty sector state without claiming it is still loading', () => {
    render(<SectorTreemap spotData={[]} />)

    expect(screen.getByText('No data available')).toBeInTheDocument()
    expect(screen.queryByText('Loading market data')).not.toBeInTheDocument()
  })
})

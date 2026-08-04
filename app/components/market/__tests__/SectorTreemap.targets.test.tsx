import { fireEvent, render, screen } from '@testing-library/react'
import SectorTreemap from '../SectorTreemap'
import type { SpotCoin } from '@/lib/hooks/useMarketSpot'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          sectorTreemapTitle: 'Sector performance',
          sectorTreemap1h: '1H',
          sectorTreemap24h: '24H',
          sectorTreemap7d: '7D',
          sectorTreemapOthers: 'Others',
          sectorTreemapMCap: 'Market cap',
          sectorTreemapBigDrop: 'Big drop',
          sectorTreemapDip: 'Dip',
          sectorTreemapRise: 'Rise',
          sectorTreemapRally: 'Rally',
          noDataGeneric: 'No data available',
          dataUnavailable: 'Unavailable',
          notAvailable: 'N/A',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

function coin(symbol: string, marketCap: number, rank: number): SpotCoin {
  return {
    id: symbol.toLowerCase(),
    symbol,
    name: symbol,
    image: null,
    price: 10,
    change1h: 1,
    change24h: 2,
    change7d: 3,
    high24h: 11,
    low24h: 9,
    volume24h: marketCap / 10,
    marketCap,
    rank,
  }
}

const spotData: SpotCoin[] = [
  coin('BTC', 1_000_000_000_000, 1),
  coin('ETH', 200_000_000_000, 2),
  coin('SOL', 1_000_000_000, 3),
  coin('LINK', 1_000_000_000, 4),
  coin('ARB', 1_000_000_000, 5),
  coin('DOGE', 1_000_000_000, 6),
  coin('RNDR', 1_000_000_000, 7),
  coin('FIL', 1_000_000_000, 8),
]

describe('SectorTreemap pointer and keyboard targets', () => {
  const originalResizeObserver = global.ResizeObserver

  beforeAll(() => {
    global.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe() {
        this.callback(
          [
            {
              contentRect: { width: 320, height: 240 },
            } as ResizeObserverEntry,
          ],
          this
        )
      }

      unobserve() {}
      disconnect() {}
    }
  })

  afterAll(() => {
    global.ResizeObserver = originalResizeObserver
  })

  it('only exposes chart tiles as buttons when both sides meet 44px', () => {
    const onSectorClick = jest.fn()
    render(<SectorTreemap spotData={spotData} onSectorClick={onSectorClick} />)

    const tiles = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="treemap-tile-"]')
    )
    const actionableTiles = tiles.filter((tile) => tile.getAttribute('role') === 'button')
    const visualOnlyTiles = tiles.filter((tile) => tile.getAttribute('role') === 'img')

    expect(actionableTiles.length).toBeGreaterThan(0)
    expect(visualOnlyTiles.length).toBeGreaterThan(0)

    for (const tile of actionableTiles) {
      expect(Number.parseFloat(tile.style.width)).toBeGreaterThanOrEqual(44)
      expect(Number.parseFloat(tile.style.height)).toBeGreaterThanOrEqual(44)
      expect(tile.tabIndex).toBe(0)
    }

    const largeTile = actionableTiles[0]
    fireEvent.keyDown(largeTile, { key: 'Enter' })
    fireEvent.keyDown(largeTile, { key: ' ' })
    expect(onSectorClick).toHaveBeenNthCalledWith(1, 'L1')
    expect(onSectorClick).toHaveBeenNthCalledWith(2, 'L1')

    const smallTile = visualOnlyTiles.find(
      (tile) =>
        Number.parseFloat(tile.style.width) < 44 || Number.parseFloat(tile.style.height) < 44
    )
    expect(smallTile).toBeDefined()
    expect(smallTile).not.toHaveAttribute('tabindex')

    fireEvent.click(smallTile!)
    expect(onSectorClick).toHaveBeenCalledTimes(2)

    const smallName = smallTile!.dataset.testid!.replace('treemap-tile-', '')
    const compactAction = screen.getByTestId(`treemap-compact-action-${smallName}`)
    expect(compactAction.tagName).toBe('BUTTON')
    expect(compactAction.tabIndex).toBe(0)
    expect(compactAction).toHaveStyle({ minWidth: '44px', minHeight: '44px' })

    fireEvent.click(compactAction)
    expect(onSectorClick).toHaveBeenLastCalledWith('Other')
  })

  it('keeps non-actionable charts informational when no callback exists', () => {
    render(<SectorTreemap spotData={spotData} />)

    const tiles = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="treemap-tile-"]')
    )
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.every((tile) => tile.getAttribute('role') === 'img')).toBe(true)
    expect(screen.queryByTestId('treemap-compact-actions')).not.toBeInTheDocument()
  })

  it('keeps each timeframe control at least 44px and reports its state', () => {
    render(<SectorTreemap spotData={spotData} />)

    const selected = screen.getByRole('button', { name: '24H' })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(selected).toHaveStyle({ minWidth: '44px', minHeight: '44px' })

    const next = screen.getByRole('button', { name: '7D' })
    fireEvent.click(next)
    expect(next).toHaveAttribute('aria-pressed', 'true')
    expect(selected).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not turn missing timeframe changes into a healthy zero', () => {
    render(
      <SectorTreemap
        spotData={spotData.map((item) => ({ ...item, change1h: null }))}
        onSectorClick={jest.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '1H' }))

    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.queryByText('+0.0%')).not.toBeInTheDocument()
    expect(screen.queryByTestId('treemap-compact-actions')).not.toBeInTheDocument()
  })
})

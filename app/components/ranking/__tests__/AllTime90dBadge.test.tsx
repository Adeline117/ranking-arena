import { render, screen } from '@testing-library/react'
import { TraderMetricCells } from '../TraderMetricCells'
import { RankingPeriodContext, type RankingPeriod } from '../RankingPeriodContext'
import type { Trader } from '../RankingTable'
import { isAllTime90dSource } from '@/lib/utils/all-time-90d'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

function row(source: string): Trader {
  return { id: 't', handle: 't', source, roi: 10, followers: 0, arena_score: 50, rank: 4 }
}

function renderCells(source: string, period: RankingPeriod | null) {
  return render(
    <RankingPeriodContext.Provider value={period}>
      <div>
        <TraderMetricCells
          trader={row(source)}
          rank={4}
          language="en"
          getPnLTooltipFn={() => ''}
          t={(key) => key}
        />
      </div>
    </RankingPeriodContext.Provider>
  )
}

describe('Hyperliquid 90D = all-time disclosure', () => {
  it('recognises the public serving slug and the legacy connector slug', () => {
    expect(isAllTime90dSource('hyperliquid')).toBe(true)
    expect(isAllTime90dSource('hyperliquid_perp')).toBe(true)
    expect(isAllTime90dSource('bybit')).toBe(false)
    expect(isAllTime90dSource(undefined)).toBe(false)
  })

  it('marks the ROI cell of a hyperliquid row on the 90D board', () => {
    renderCells('hyperliquid', '90D')
    const badge = screen.getByTestId('alltime-90d-badge')
    expect(badge).toHaveTextContent('allTime90dShort')
    expect(badge).toHaveAttribute('title', 'allTime90dTooltip')
  })

  it('does not mark 30D/7D or other sources', () => {
    renderCells('hyperliquid', '30D')
    expect(screen.queryByTestId('alltime-90d-badge')).not.toBeInTheDocument()
  })

  it('does not mark non-hyperliquid sources on 90D', () => {
    renderCells('bybit', '90D')
    expect(screen.queryByTestId('alltime-90d-badge')).not.toBeInTheDocument()
  })
})

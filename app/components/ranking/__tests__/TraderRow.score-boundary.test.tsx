import React from 'react'
import { render, screen } from '@testing-library/react'
import type { Trader } from '../RankingTableTypes'

const mockComparisonState = {
  isSelected: jest.fn(() => false),
  canAddMore: jest.fn(() => true),
  addTrader: jest.fn(),
  removeTrader: jest.fn(),
}

const mockUseComparisonStore = Object.assign(
  jest.fn((selector: (state: typeof mockComparisonState) => unknown) =>
    selector(mockComparisonState)
  ),
  { getState: () => mockComparisonState }
)

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/stores/comparisonStore', () => ({
  useComparisonStore: (...args: unknown[]) => mockUseComparisonStore(...args),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))

jest.mock('next/dynamic', () => {
  let dynamicCall = 0
  return () => {
    dynamicCall += 1
    if (dynamicCall === 2) {
      function MockScoreBreakdownTooltip({ trader }: { trader: Trader }) {
        return (
          <span data-testid="breakdown-tooltip-score">
            {trader.arena_score == null ? 'unknown' : String(trader.arena_score)}
          </span>
        )
      }
      return MockScoreBreakdownTooltip
    }
    return () => null
  }
})

jest.mock('../shared/TraderDisplay', () => ({
  RankDisplay: () => null,
  ArenaScoreCircle: ({ score, trader }: { score: number | null | undefined; trader?: Trader }) => (
    <span data-testid="circle-score">
      {score == null ? 'unknown' : String(score)} /{' '}
      {trader?.arena_score == null ? 'unknown' : String(trader.arena_score)}
    </span>
  ),
  areTraderPropsEqual: () => false,
}))

jest.mock('../ScoreMiniBar', () => ({
  __esModule: true,
  default: ({ score }: { score: number }) => <span data-testid="mini-bar-score">{score}</span>,
}))

jest.mock('../TraderInfoCell', () => ({ TraderInfoCell: () => null }))
jest.mock('../TraderMetricCells', () => ({ TraderMetricCells: () => null }))
jest.mock('../TraderRowSwipeActions', () => ({
  TraderRowSwipeActions: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))

import { TraderRow } from '../TraderRow'

describe('TraderRow score presentation boundary', () => {
  it('normalizes a corrupt score before it reaches circle, tooltip, or mini-bar', () => {
    render(
      <TraderRow
        trader={{
          id: 'non-finite-score',
          handle: 'Non Finite',
          roi: 10,
          followers: 0,
          arena_score: Number.NaN,
        }}
        rank={7}
        language="en"
        getMedalGlowClass={() => ''}
        parseSourceInfo={() => ({
          exchange: 'Binance',
          type: 'Futures',
          typeColor: 'var(--color-text-tertiary)',
        })}
        getPnLTooltipFn={() => ''}
        onToggleExpand={jest.fn()}
      />
    )

    expect(screen.getByTestId('circle-score')).toHaveTextContent('unknown / unknown')
    expect(screen.getByTestId('breakdown-tooltip-score')).toHaveTextContent('unknown')
    expect(screen.queryByTestId('mini-bar-score')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'expandScoreDetails' })).not.toBeInTheDocument()
  })
})

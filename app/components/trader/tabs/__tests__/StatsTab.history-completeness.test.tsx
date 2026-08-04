import { render, screen } from '@testing-library/react'
import StatsTab from '../StatsTab'

const mockStatsPage = jest.fn((_props: Record<string, unknown>) => <div data-testid="stats-page" />)

jest.mock('next/dynamic', () => () => (props: Record<string, unknown>) => mockStatsPage(props))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

const baseProps = {
  visited: true,
  stats: undefined,
  traderHandle: 'trader-a',
  assetBreakdown: undefined,
  equityCurve: undefined,
  positionHistory: [],
  isPro: true,
  onUnlock: jest.fn(),
}

describe('StatsTab history completeness', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders the disclosure path even when every data array is empty', () => {
    const completeness = {
      state: 'unknown' as const,
      reason: 'history_evidence_not_bound' as const,
    }
    render(<StatsTab {...baseProps} historyCompleteness={completeness} />)

    expect(screen.getByTestId('stats-page')).toBeInTheDocument()
    expect(mockStatsPage).toHaveBeenCalledWith(
      expect.objectContaining({ historyCompleteness: completeness })
    )
  })

  it('keeps the legacy empty state when no serving evidence exists', () => {
    render(<StatsTab {...baseProps} historyCompleteness={null} />)

    expect(screen.queryByTestId('stats-page')).not.toBeInTheDocument()
    expect(screen.getByText('noStatsData')).toBeInTheDocument()
  })
})

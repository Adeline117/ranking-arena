import { render, screen } from '@testing-library/react'
import PortfolioTab from '../PortfolioTab'

const mockPortfolioTable = jest.fn((_props: Record<string, unknown>) => (
  <div data-testid="portfolio-table" />
))

jest.mock('next/dynamic', () => () => (props: Record<string, unknown>) => mockPortfolioTable(props))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

const baseProps = {
  visited: true,
  portfolio: [],
  positionHistory: [],
  source: 'gmx',
  isPro: true,
  onUnlock: jest.fn(),
}

describe('PortfolioTab history completeness', () => {
  beforeEach(() => jest.clearAllMocks())

  it('routes an empty partial history through the disclosure-aware table', () => {
    const completeness = {
      state: 'partial' as const,
      reason: 'interactive_preview' as const,
    }
    render(<PortfolioTab {...baseProps} historyCompleteness={completeness} />)

    expect(screen.getByTestId('portfolio-table')).toBeInTheDocument()
    expect(mockPortfolioTable).toHaveBeenCalledWith(
      expect.objectContaining({ historyCompleteness: completeness })
    )
  })

  it('preserves the legacy empty state when no serving evidence exists', () => {
    render(<PortfolioTab {...baseProps} historyCompleteness={null} />)

    expect(screen.queryByTestId('portfolio-table')).not.toBeInTheDocument()
    expect(screen.getByText('noPortfolioData')).toBeInTheDocument()
  })

  it('shows the verification placeholder for an empty portfolio while history is quarantined', () => {
    render(<PortfolioTab {...baseProps} historyCompleteness={null} historyUnderVerification />)

    expect(screen.queryByText('noPortfolioData')).not.toBeInTheDocument()
    expect(screen.getByText('historyVerificationTitle')).toBeInTheDocument()
  })
})

import { fireEvent, render, screen, within } from '@testing-library/react'

jest.mock('next/dynamic', () => () => () => null)
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/premium/ShareCompareButton', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/app/components/utils/ErrorBoundary', () => ({
  CompactErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('@/lib/utils/avatar', () => ({
  getAvatarGradient: () => 'none',
  getAvatarInitial: (name: string) => name.slice(0, 1),
  getTraderAvatarUrl: () => null,
  isWalletAddress: () => false,
  generateBlockieSvg: () => '',
}))
jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    Text: ({
      as: Component = 'span',
      children,
      ...props
    }: {
      as?: React.ElementType
      children?: React.ReactNode
      [key: string]: unknown
    }) => {
      const { size: _size, weight: _weight, color: _color, ...domProps } = props
      return <Component {...domProps}>{children}</Component>
    },
  }
})

import TraderComparison from '../TraderComparison'

describe('TraderComparison score bars', () => {
  it('distinguishes measured zero dimensions from unavailable dimensions', () => {
    render(
      <TraderComparison
        traders={[
          {
            id: 'zero',
            handle: 'Measured Zero',
            source: 'bybit',
            roi: 0,
            profitability_score: 0,
            risk_control_score: 0,
            execution_score: 0,
            win_rate: 0,
            arena_score: 0,
          },
          {
            id: 'unknown',
            handle: 'Unknown Metrics',
            source: 'binance_futures',
            roi: 1,
          },
          {
            id: 'invalid',
            handle: 'Invalid Metrics',
            source: 'okx_web3',
            roi: 2,
            profitability_score: Number.NaN,
            risk_control_score: -1,
            execution_score: 101,
            win_rate: Number.POSITIVE_INFINITY,
            arena_score: -5,
          },
        ]}
        showRemoveButton={false}
      />
    )

    for (const label of [
      'compareArenaScore',
      'compareWinRate',
      'scoreProfit',
      'scoreRisk',
      'scoreExecution',
    ]) {
      const rowHeader = screen.getByRole('rowheader', { name: label })
      const cells = within(rowHeader.closest('tr')!).getAllByRole('cell')
      expect(cells).toHaveLength(3)
      expect(cells[0]).toHaveTextContent(/^0\.0%?/)
      expect(within(cells[0]).getByText('compareBestValue')).toBeInTheDocument()
      expect(cells[1]).toHaveTextContent('—')
      expect(cells[2]).toHaveTextContent('—')
      expect(within(cells[1]).queryByText('compareBestValue')).not.toBeInTheDocument()
      expect(within(cells[2]).queryByText('compareBestValue')).not.toBeInTheDocument()
    }

    fireEvent.click(screen.getByRole('button', { name: 'compareScoreBars' }))

    const progressBars = screen.getAllByRole('progressbar')
    expect(progressBars).toHaveLength(15)
    expect(new Set(progressBars.map((bar) => bar.getAttribute('aria-label'))).size).toBe(15)

    const zeroBars = progressBars.filter((bar) =>
      bar.getAttribute('aria-label')?.endsWith(': Measured Zero')
    )
    const unknownBars = progressBars.filter((bar) =>
      bar.getAttribute('aria-label')?.endsWith(': Unknown Metrics')
    )
    const invalidBars = progressBars.filter((bar) =>
      bar.getAttribute('aria-label')?.endsWith(': Invalid Metrics')
    )

    expect(zeroBars).toHaveLength(5)
    expect(unknownBars).toHaveLength(5)
    expect(invalidBars).toHaveLength(5)
    for (const bar of zeroBars) {
      expect(bar).toHaveAttribute('aria-valuenow', '0')
      expect(bar).toHaveAttribute('aria-valuetext', '0')
      expect(within(bar.parentElement!).getByText('0')).toBeInTheDocument()
    }
    for (const bar of [...unknownBars, ...invalidBars]) {
      expect(bar).not.toHaveAttribute('aria-valuenow')
      expect(bar).toHaveAttribute('aria-valuetext', 'notAvailable')
      expect(within(bar.parentElement!).getByText('—')).toBeInTheDocument()
    }
  })
})

import { render, screen } from '@testing-library/react'
import { tokens } from '@/lib/design-tokens'
import TopTraders from '../TopTraders'

const mockUseQuery = jest.fn()

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({ sidebarTopTraders: 'Top Traders', sidebarLoadFailed: 'Failed', retry: 'Retry' })[key] ??
      key,
  }),
}))

jest.mock('../SidebarCard', () => ({
  __esModule: true,
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}))

describe('TopTraders rank authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUseQuery.mockReturnValue({
      data: {
        traders: [
          {
            source: 'binance_futures',
            source_trader_id: 'one',
            handle: 'One',
            avatar_url: null,
            roi: 10,
            arena_score: 99,
            rank: 1,
          },
          {
            source: 'okx_futures',
            source_trader_id: 'twelve',
            handle: 'Twelve',
            avatar_url: null,
            roi: 8,
            arena_score: 95,
            rank: 12,
          },
          {
            source: 'binance_futures',
            source_trader_id: 'two',
            handle: 'Two',
            avatar_url: null,
            roi: 7,
            arena_score: 90,
            rank: 2,
          },
        ],
      },
      error: null,
      isLoading: false,
      refetch: jest.fn(),
    })
  })

  it('renders persisted ranks instead of diversified response positions', () => {
    render(<TopTraders />)

    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#12')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
    expect(screen.queryByText('#3')).not.toBeInTheDocument()

    expect(screen.getByText('#1').style.color).toBe('rgb(255, 215, 0)')
    expect(screen.getByText('#2').style.color).toBe('rgb(192, 192, 192)')
    expect(screen.getByText('#12').style.color).toBe(tokens.colors.text.tertiary)
  })
})

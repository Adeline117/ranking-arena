import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import RecommendedGroups from '../RecommendedGroups'

const groupDirectoryQuery = jest.fn()

jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query')
  return {
    ...actual,
    useQuery: (options: Record<string, unknown>) => actual.useQuery({ ...options, retry: false }),
  }
})

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ accessToken: null }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          sidebarRecommendedGroups: 'Recommended Groups',
          sidebarLoadFailedShort: 'Failed to load',
          sidebarNoGroups: 'No groups available',
          retry: 'Retry',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: jest.fn(() => ({
          limit: (...args: unknown[]) => groupDirectoryQuery(...args),
        })),
      })),
    })),
  },
}))

jest.mock('../SidebarCard', () => ({
  __esModule: true,
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}))

function renderWidget() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RecommendedGroups />
    </QueryClientProvider>
  )
}

describe('RecommendedGroups failure state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows a retryable error before a successful empty result', async () => {
    groupDirectoryQuery
      .mockResolvedValueOnce({ data: null, error: { message: 'database unavailable' } })
      .mockResolvedValueOnce({ data: [], error: null })

    renderWidget()

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load')
    expect(screen.queryByText('No groups available')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(groupDirectoryQuery).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No groups available')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import RecommendedGroups from '../RecommendedGroups'

type MockAuth = {
  accessToken: string | null
  viewerKey: 'pending' | `user:${string}`
  sessionGeneration: number
}

type FetchResult = {
  ok: boolean
  json: () => Promise<unknown>
}

const mockUseAuthSession = jest.fn<MockAuth, []>()
const groupDirectoryQuery = jest.fn()
const fetchMock = jest.fn<Promise<FetchResult>, Parameters<typeof fetch>>()

jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query')
  return {
    ...actual,
    useQuery: (options: Record<string, unknown>) => actual.useQuery({ ...options, retry: false }),
  }
})

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          members: 'members',
          sidebarRecommendedGroups: 'Recommended Groups',
          sidebarNoGroups: 'No groups available',
          u9grp_reasonFollowedJoined: 'People you follow joined',
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function personalizedGroup(id: string, name: string): FetchResult {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: {
        personalized: true,
        groups: [
          {
            id,
            name,
            name_en: name,
            description: null,
            description_en: null,
            avatar_url: null,
            member_count: 3,
            recommendation_reason: 'followed_users_joined',
          },
        ],
      },
    }),
  }
}

function authFor(user: string, sessionGeneration: number, token = `token-${user}`): MockAuth {
  return {
    accessToken: token,
    viewerKey: `user:${user}`,
    sessionGeneration,
  }
}

describe('RecommendedGroups viewer ownership', () => {
  let auth: MockAuth
  let queryClient: QueryClient

  beforeEach(() => {
    jest.clearAllMocks()
    auth = authFor('a', 1)
    mockUseAuthSession.mockImplementation(() => auth)
    groupDirectoryQuery.mockResolvedValue({ data: [], error: null })
    globalThis.fetch = fetchMock as typeof fetch
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  })

  afterEach(() => {
    queryClient.clear()
  })

  function renderWidget() {
    return render(
      <QueryClientProvider client={queryClient}>
        <RecommendedGroups />
      </QueryClientProvider>
    )
  }

  it('hides A recommendations immediately while B is unresolved and never uses them for B', async () => {
    const userB = deferred<FetchResult>()
    fetchMock
      .mockResolvedValueOnce(personalizedGroup('group-a', 'A private recommendation'))
      .mockImplementationOnce(() => userB.promise)

    const view = renderWidget()
    expect(await screen.findByText('A private recommendation')).toBeInTheDocument()
    expect(screen.getByText('People you follow joined')).toBeInTheDocument()

    auth = { accessToken: null, viewerKey: 'pending', sessionGeneration: 2 }
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <RecommendedGroups />
      </QueryClientProvider>
    )

    expect(screen.queryByText('A private recommendation')).not.toBeInTheDocument()
    expect(screen.queryByText('People you follow joined')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(groupDirectoryQuery).not.toHaveBeenCalled()

    auth = authFor('b', 3)
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <RecommendedGroups />
      </QueryClientProvider>
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('A private recommendation')).not.toBeInTheDocument()

    await act(async () => {
      userB.resolve(personalizedGroup('group-b', 'B recommendation'))
      await userB.promise
    })
    expect(await screen.findByText('B recommendation')).toBeInTheDocument()
    expect(screen.queryByText('A private recommendation')).not.toBeInTheDocument()
  })

  it('keeps the same viewer cache across access-token refreshes', async () => {
    fetchMock.mockResolvedValueOnce(personalizedGroup('group-a', 'Stable recommendation'))
    const view = renderWidget()
    expect(await screen.findByText('Stable recommendation')).toBeInTheDocument()

    auth = authFor('a', 1, 'token-a-refreshed')
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <RecommendedGroups />
      </QueryClientProvider>
    )

    expect(screen.getByText('Stable recommendation')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

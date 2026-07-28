import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import GroupsFeedPage from '../GroupsFeedPage'

type MockAuth = {
  authChecked: boolean
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | 'pending' | `user:${string}`
}

type QueryResult<T> = {
  data: T
  error: null
}

const mockMembershipQuery = jest.fn()
const mockGroupLookupQuery = jest.fn()
const mockPostFeedRender = jest.fn()
let mockAuth: MockAuth

function authFor(userId: string, sessionGeneration: number): MockAuth {
  return {
    authChecked: true,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}`,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          following: 'Following',
          recommended: 'Recommended',
          sidebarLoadFailedShort: 'Failed to load',
          loadFailedRetryShort: 'Failed to load, please retry',
          retry: 'Retry',
          noGroupsFollowedYet: 'No groups followed yet',
          joinGroupsToSeePosts: 'Join groups to see their posts here',
          groupsLoginCta: 'Log in to view your groups',
          login: 'Log in',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      if (table === 'own_group_memberships') {
        return {
          select: jest.fn(() => ({
            eq: (...args: unknown[]) => mockMembershipQuery(...args),
          })),
        }
      }

      if (table === 'groups') {
        return {
          select: jest.fn(() => ({
            in: (...args: unknown[]) => mockGroupLookupQuery(...args),
            order: jest.fn(() => ({
              limit: jest.fn().mockResolvedValue({ data: [], error: null }),
            })),
          })),
        }
      }

      throw new Error(`Unexpected table: ${table}`)
    }),
  },
}))

jest.mock('@/app/components/layout/ThreeColumnLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

jest.mock('@/app/components/layout/FloatingActionButton', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/sidebar/RecommendedGroups', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/sidebar/NewsFlash', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/post/PostFeed', () => ({
  __esModule: true,
  default: (props: { groupIds?: string[] }) => {
    mockPostFeedRender(props)
    return <div>Post feed</div>
  },
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

describe('GroupsFeedPage joined-groups viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = authFor('viewer-a', 1)
  })

  it('fails closed during pending and A→B transitions, then shows truthful anonymous UI', async () => {
    mockMembershipQuery.mockImplementation((_column: string, userId: string) =>
      Promise.resolve({
        data: userId === 'viewer-a' ? [{ group_id: 'group-a', pinned: false }] : [],
        error: null,
      })
    )
    mockGroupLookupQuery.mockResolvedValue({
      data: [
        {
          id: 'group-a',
          name: 'A private group',
          name_en: 'A private group',
          avatar_url: null,
          member_count: 2,
        },
      ],
      error: null,
    })

    const { rerender } = render(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Following' }))

    expect(await screen.findByText('A private group')).toBeInTheDocument()

    mockPostFeedRender.mockClear()
    mockAuth = {
      authChecked: false,
      loading: true,
      sessionGeneration: 2,
      userId: null,
      viewerKey: 'pending',
    }
    rerender(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)

    expect(screen.queryByText('A private group')).not.toBeInTheDocument()
    expect(screen.getByRole('main').querySelector('[aria-busy="true"]')).toBeInTheDocument()
    expect(
      mockPostFeedRender.mock.calls.some(([props]) => props.groupIds?.includes('group-a'))
    ).toBe(false)

    mockAuth = authFor('viewer-b', 3)
    rerender(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)

    expect(screen.queryByText('A private group')).not.toBeInTheDocument()
    expect(await screen.findByText('No groups followed yet')).toBeInTheDocument()

    mockAuth = {
      authChecked: true,
      loading: false,
      sessionGeneration: 4,
      userId: null,
      viewerKey: 'anon',
    }
    rerender(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)

    expect(screen.queryByText('A private group')).not.toBeInTheDocument()
    expect(screen.getByText('Log in to view your groups')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute(
      'href',
      '/login?returnUrl=/groups'
    )
  })

  it('does not publish A second-stage completion after B becomes current', async () => {
    const aGroups = deferred<
      QueryResult<
        Array<{
          id: string
          name: string
          name_en: string
          avatar_url: null
          member_count: number
        }>
      >
    >()

    let bLoads = 0
    mockMembershipQuery.mockImplementation((_column: string, userId: string) => {
      if (userId === 'viewer-a') {
        return Promise.resolve({
          data: [{ group_id: 'group-a', pinned: true }],
          error: null,
        })
      }

      bLoads += 1
      return Promise.resolve(
        bLoads === 1
          ? { data: null, error: { message: 'B temporary failure' } }
          : { data: [], error: null }
      )
    })
    mockGroupLookupQuery.mockReturnValue(aGroups.promise)

    const { rerender } = render(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Following' }))
    await waitFor(() => expect(mockGroupLookupQuery).toHaveBeenCalledWith('id', ['group-a']))

    mockAuth = authFor('viewer-b', 2)
    rerender(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No groups followed yet')).toBeInTheDocument()
    expect(bLoads).toBe(2)

    await act(async () => {
      aGroups.resolve({
        data: [
          {
            id: 'group-a',
            name: 'Late A group',
            name_en: 'Late A group',
            avatar_url: null,
            member_count: 1,
          },
        ],
        error: null,
      })
      await aGroups.promise
    })

    expect(screen.queryByText('Late A group')).not.toBeInTheDocument()
    expect(screen.getByText('No groups followed yet')).toBeInTheDocument()
  })

  it('treats a new generation of the same user as a new owner', async () => {
    let load = 0
    mockMembershipQuery.mockImplementation(() => {
      load += 1
      return Promise.resolve({
        data: [{ group_id: load === 1 ? 'old-group' : 'new-group', pinned: false }],
        error: null,
      })
    })
    mockGroupLookupQuery.mockImplementation((_column: string, ids: string[]) =>
      Promise.resolve({
        data: [
          {
            id: ids[0],
            name: ids[0] === 'old-group' ? 'Old session group' : 'New session group',
            name_en: ids[0] === 'old-group' ? 'Old session group' : 'New session group',
            avatar_url: null,
            member_count: 1,
          },
        ],
        error: null,
      })
    )

    const { rerender } = render(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Following' }))
    expect(await screen.findByText('Old session group')).toBeInTheDocument()

    mockPostFeedRender.mockClear()
    mockAuth = authFor('viewer-a', 2)
    rerender(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)

    expect(screen.queryByText('Old session group')).not.toBeInTheDocument()
    expect(
      mockPostFeedRender.mock.calls.some(([props]) => props.groupIds?.includes('old-group'))
    ).toBe(false)
    expect(await screen.findByText('New session group')).toBeInTheDocument()
    expect(mockMembershipQuery).toHaveBeenCalledTimes(2)
  })
})

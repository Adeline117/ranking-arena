import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import GroupsFeedPage from '../GroupsFeedPage'

const membershipQuery = jest.fn()
const groupDirectoryQuery = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ userId: 'viewer-1' }),
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
            eq: (...args: unknown[]) => membershipQuery(...args),
          })),
        }
      }

      if (table === 'groups') {
        return {
          select: jest.fn(() => ({
            order: jest.fn(() => ({
              limit: (...args: unknown[]) => groupDirectoryQuery(...args),
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
  default: () => <div>Post feed</div>,
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

describe('GroupsFeedPage joined-groups failure state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows a retryable error instead of the genuine empty state', async () => {
    membershipQuery
      .mockResolvedValueOnce({ data: null, error: { message: 'database unavailable' } })
      .mockResolvedValueOnce({ data: [], error: null })

    render(<GroupsFeedPage initialPosts={[]} initialGroups={[]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Following' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')
    expect(screen.queryByText('No groups followed yet')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(membershipQuery).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No groups followed yet')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps a failed recommended seed distinct from an empty recommendation list', async () => {
    membershipQuery.mockResolvedValue({ data: [], error: null })
    groupDirectoryQuery.mockResolvedValue({ data: [], error: null })

    render(<GroupsFeedPage initialPosts={[]} initialGroups={[]} initialGroupsStatus="error" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(groupDirectoryQuery).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})

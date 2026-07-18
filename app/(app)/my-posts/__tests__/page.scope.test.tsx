import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'

const mockReplace = jest.fn()
const mockMaybeSingle = jest.fn()
let mockAuth: AuthSessionReturn

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
  useRouter: () => ({ replace: mockReplace }),
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args),
        })),
      })),
    })),
  },
}))

jest.mock('@/app/components/ui/PageSkeleton', () => ({
  PostFeedPageSkeleton: () => <div data-testid="my-posts-loading">Loading</div>,
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({ title, retry }: { title: string; retry: () => void }) => (
    <section role="alert">
      <h2>{title}</h2>
      <button type="button" onClick={retry}>
        Retry
      </button>
    </section>
  ),
}))

import MyPostsPage from '../page'

function authState({
  authChecked,
  loading,
  userId,
  sessionGeneration = 1,
}: {
  authChecked: boolean
  loading: boolean
  userId: string | null
  sessionGeneration?: number
}) {
  return {
    authChecked,
    loading,
    userId,
    viewerKey: authChecked ? (userId ? `user:${userId}` : 'anon') : 'pending',
    sessionGeneration,
  } as AuthSessionReturn
}

describe('/my-posts viewer routing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = authState({ authChecked: false, loading: true, userId: null })
  })

  it('waits for auth bootstrap instead of redirecting an unresolved viewer', () => {
    render(<MyPostsPage />)

    expect(screen.getByTestId('my-posts-loading')).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockMaybeSingle).not.toHaveBeenCalled()
  })

  it('routes a confirmed anonymous viewer to login', async () => {
    mockAuth = authState({ authChecked: true, loading: false, userId: null })

    render(<MyPostsPage />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login?redirect=/my-posts')
    })
    expect(mockMaybeSingle).not.toHaveBeenCalled()
  })

  it('loads the confirmed viewer handle before opening their profile', async () => {
    mockAuth = authState({ authChecked: true, loading: false, userId: 'user-a' })
    mockMaybeSingle.mockResolvedValue({
      data: { handle: 'alice/name' },
      error: null,
    })

    render(<MyPostsPage />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/u/alice%2Fname')
    })
  })

  it('keeps profile lookup failures retryable instead of routing to a false destination', async () => {
    mockAuth = authState({ authChecked: true, loading: false, userId: 'user-a' })
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'temporary failure' } })

    render(<MyPostsPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your profile')
    expect(mockReplace).not.toHaveBeenCalled()

    mockMaybeSingle.mockResolvedValue({ data: { handle: 'alice' }, error: null })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/u/alice')
    })
  })

  it('sends a genuine missing handle to profile setup', async () => {
    mockAuth = authState({ authChecked: true, loading: false, userId: 'user-a' })
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    render(<MyPostsPage />)

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/settings?section=profile')
    })
  })
})

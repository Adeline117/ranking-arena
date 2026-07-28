import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ConversationsList from '../ConversationsList'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}))

const mockShowToast = jest.fn()
const mockSetUnreadMessages = jest.fn()
const mockRemoveChannel = jest.fn()
type MockRealtimeChannel = {
  name: string
  on: jest.Mock
  subscribe: jest.Mock
  topic: string
}
const mockRegisteredChannels: MockRealtimeChannel[] = []
const mockChannel = jest.fn((name: string) => {
  const existing = mockRegisteredChannels.find(
    (candidate) => candidate.topic === `realtime:${name}`
  )
  if (existing) return existing

  const channel: MockRealtimeChannel = {
    name,
    topic: `realtime:${name}`,
    on: jest.fn(() => channel),
    subscribe: jest.fn(() => channel),
  }
  mockRegisteredChannels.push(channel)
  return channel
})
const token = (subject: string) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: subject })}.signature`
}
const mockAuthState = {
  user: { id: 'user-1' } as { id: string } | null,
  userId: 'user-1' as string | null,
  email: 'user-1@example.com' as string | null,
  accessToken: token('user-1') as string | null,
  isLoggedIn: true,
  loading: false,
  authChecked: true,
  sessionGeneration: 1,
  viewerKey: 'user:user-1',
}

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          allChats: 'All',
          createGroupChat: 'Create group chat',
          directMessages: 'Direct',
          failedToLoadRetryShort: 'Failed to load, please retry',
          groupMessages: 'Groups',
          loading: 'Loading...',
          noMessages: 'No messages',
          retry: 'Retry',
          somethingWentWrong: 'Something went wrong',
          u10inbox_dmEmptyCta: 'Start a conversation',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    channel: (...args: unknown[]) => mockChannel(...args),
    getChannels: () => [...mockRegisteredChannels],
    removeChannel: (...args: unknown[]) => mockRemoveChannel(...args),
  },
}))

jest.mock('@/lib/stores/inboxStore', () => {
  const state = {
    activateViewer: jest.fn(),
    setUnreadMessages: (...args: unknown[]) => mockSetUnreadMessages(...args),
  }
  const useInboxStore = (selector: (value: typeof state) => unknown) => selector(state)
  return { useInboxStore }
})

const originalFetch = global.fetch

describe('ConversationsList load failure', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRegisteredChannels.splice(0)
    mockRemoveChannel.mockImplementation(async (channel: MockRealtimeChannel) => {
      const index = mockRegisteredChannels.indexOf(channel)
      if (index >= 0) mockRegisteredChannels.splice(index, 1)
      return 'ok'
    })
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-1')
    mockAuthState.user = { id: 'user-1' }
    mockAuthState.userId = 'user-1'
    mockAuthState.email = 'user-1@example.com'
    mockAuthState.accessToken = token('user-1')
    mockAuthState.isLoggedIn = true
    mockAuthState.loading = false
    mockAuthState.authChecked = true
    mockAuthState.sessionGeneration = scope.sessionGeneration
    mockAuthState.viewerKey = 'user:user-1'
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('keeps auth bootstrap in a loading state without requesting or showing empty data', () => {
    mockAuthState.user = null
    mockAuthState.userId = null
    mockAuthState.email = null
    mockAuthState.accessToken = null
    mockAuthState.isLoggedIn = false
    mockAuthState.loading = true
    mockAuthState.authChecked = false
    mockAuthState.viewerKey = 'pending'
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ConversationsList />
      </QueryClientProvider>
    )

    expect(screen.getByRole('status', { name: 'Loading...' })).toBeInTheDocument()
    expect(screen.queryByText('No messages')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows retry instead of a normal empty-conversations state', async () => {
    let conversationAttempts = 0
    let groupAttempts = 0
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/conversations') {
        conversationAttempts += 1
        if (conversationAttempts === 1) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: 'Unavailable' }),
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ conversations: [] }),
        }
      }
      groupAttempts += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ channels: [] }),
      }
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ConversationsList />
      </QueryClientProvider>
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')
    expect(screen.getByRole('alert')).toHaveTextContent('Direct')
    expect(screen.queryByText('No messages')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(conversationAttempts).toBe(2))
    expect(groupAttempts).toBe(1)
    expect(await screen.findByText('No messages')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps direct conversations visible when group channels fail and retries only groups', async () => {
    let conversationAttempts = 0
    let groupAttempts = 0
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/conversations') {
        conversationAttempts += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversations: [
              {
                id: 'conversation-1',
                other_user: { id: 'user-2', handle: 'Alice', avatar_url: null },
                last_message_at: '2026-07-18T12:00:00.000Z',
                last_message_preview: 'Hello',
                unread_count: 1,
              },
            ],
          }),
        }
      }

      groupAttempts += 1
      if (groupAttempts === 1) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'Unavailable' }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          channels: [
            {
              id: 'channel-1',
              name: 'Research group',
              type: 'group',
              avatar_url: null,
              last_message_at: '2026-07-18T12:00:00.000Z',
              last_message_preview: 'New signal',
            },
          ],
        }),
      }
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ConversationsList />
      </QueryClientProvider>
    )

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Groups')
    expect(screen.queryByText('No messages')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Research group')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(conversationAttempts).toBe(1)
    expect(groupAttempts).toBe(2)
  })

  it('gives two same-viewer instances independent physical realtime topics', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return {
        ok: true,
        status: 200,
        json: async () => (url === '/api/conversations' ? { conversations: [] } : { channels: [] }),
      } as Response
    }) as typeof fetch
    const unhandledRejection = jest.fn()
    process.on('unhandledRejection', unhandledRejection)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConversationsList />
        <ConversationsList />
      </QueryClientProvider>
    )

    try {
      await waitFor(() => {
        const directTopics = mockChannel.mock.calls
          .map(([name]) => String(name))
          .filter((name) => name.startsWith(`inbox:user-1:${mockAuthState.sessionGeneration}:`))
        expect(directTopics).toHaveLength(2)
        expect(new Set(directTopics)).toHaveProperty('size', 2)
      })
      expect(mockRegisteredChannels).toHaveLength(2)
      expect(unhandledRejection).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      await waitFor(() => expect(mockRegisteredChannels).toHaveLength(0))
      process.removeListener('unhandledRejection', unhandledRejection)
    }
  })
})

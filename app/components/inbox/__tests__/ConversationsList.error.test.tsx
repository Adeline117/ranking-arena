import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ConversationsList from '../ConversationsList'

const mockShowToast = jest.fn()
const mockSetUnreadMessages = jest.fn()
const mockRemoveChannel = jest.fn()
const mockSubscribe = jest.fn()
const mockOn = jest.fn(() => ({ subscribe: mockSubscribe }))
const mockChannel = jest.fn(() => ({ on: mockOn }))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    user: { id: 'user-1' },
    accessToken: 'access-token',
    getAuthHeadersAsync: async () => ({ Authorization: 'Bearer access-token' }),
  }),
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
    removeChannel: (...args: unknown[]) => mockRemoveChannel(...args),
  },
}))

jest.mock('@/lib/stores/inboxStore', () => {
  const state = {
    setUnreadMessages: (...args: unknown[]) => mockSetUnreadMessages(...args),
  }
  const useInboxStore = (selector: (value: typeof state) => unknown) => selector(state)
  return { useInboxStore }
})

const originalFetch = global.fetch

describe('ConversationsList load failure', () => {
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('shows retry instead of a normal empty-conversations state', async () => {
    let conversationAttempts = 0
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/conversations') {
        conversationAttempts += 1
        if (conversationAttempts === 1) return { ok: false, status: 503 }
        return {
          ok: true,
          status: 200,
          json: async () => ({ conversations: [] }),
        }
      }
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
    expect(screen.queryByText('No messages')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(conversationAttempts).toBe(2))
    expect(await screen.findByText('No messages')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

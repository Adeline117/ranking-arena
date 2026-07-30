import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ChatSearchOverlay from '../ChatSearchOverlay'

const FIRST_MESSAGE_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const SENDER_ID = '33333333-3333-4333-8333-333333333333'

const mockLoggerError = jest.fn()

jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          enterKeywordToSearch: 'Enter keyword',
          loadingMore: 'Loading more',
          nextResult: 'Next result',
          noMessagesFound: 'No messages found',
          previousResult: 'Previous result',
          searchChatRecords: 'Search chat records',
          searchFailed: 'Search failed, please try again',
          searching: 'Searching',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

const originalFetch = global.fetch

function match(messageId: string, snippet: string, createdAt: string): Record<string, unknown> {
  return {
    message_id: messageId,
    snippet,
    created_at: createdAt,
    sender_id: SENDER_ID,
  }
}

function response(
  matches: Record<string, unknown>[],
  nextCursor: { before: string; before_id: string } | null = null
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      matches,
      next_cursor: nextCursor,
      total_in_page: matches.length,
    }),
  } as Response
}

function renderOverlay(onNavigateToMessage = jest.fn()) {
  render(
    <ChatSearchOverlay
      isOpen
      onClose={jest.fn()}
      conversationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      accessToken="token"
      onNavigateToMessage={onNavigateToMessage}
    />
  )
  return onNavigateToMessage
}

function submitSearch(query: string) {
  const input = screen.getByRole('textbox', { name: 'Search chat records' })
  fireEvent.change(input, { target: { value: query } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('ChatSearchOverlay atomic pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('sends both cursor fields and appends a strictly validated next page', async () => {
    const firstCreatedAt = '2026-07-29T12:00:00.123456+00:00'
    const secondCreatedAt = '2026-07-29T11:00:00+00:00'
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        response([match(FIRST_MESSAGE_ID, 'first hello', firstCreatedAt)], {
          before: firstCreatedAt,
          before_id: FIRST_MESSAGE_ID,
        })
      )
      .mockResolvedValueOnce(response([match(SECOND_MESSAGE_ID, 'older hello', secondCreatedAt)]))
    global.fetch = fetchMock as typeof fetch
    const onNavigate = renderOverlay()

    submitSearch('hello')
    expect(
      await screen.findByText((_content, element) => element?.textContent === 'first hello')
    ).toBeInTheDocument()
    expect(fetchMock.mock.calls[0]?.[0]).toContain('?q=hello&limit=20')

    fireEvent.click(screen.getByRole('button', { name: 'Next result' }))

    expect(
      await screen.findByText((_content, element) => element?.textContent === 'older hello')
    ).toBeInTheDocument()
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      `cursor=${encodeURIComponent(firstCreatedAt)}&cursorId=${FIRST_MESSAGE_ID}`
    )
    expect(onNavigate).toHaveBeenCalledWith(FIRST_MESSAGE_ID, firstCreatedAt)
  })

  it('surfaces malformed success data as a failure instead of a genuine empty result', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ matches: [], next_cursor: null, total_in_page: 1 }),
    }) as typeof fetch
    renderOverlay()

    submitSearch('hello')

    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed, please try again')
    expect(screen.queryByText('No messages found')).not.toBeInTheDocument()
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('ignores an older request that resolves after a newer query', async () => {
    let resolveFirst: ((value: Response) => void) | null = null
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(
        response([match(SECOND_MESSAGE_ID, 'newer query result', '2026-07-29T12:00:00+00:00')])
      )
    global.fetch = fetchMock as typeof fetch
    renderOverlay()

    submitSearch('first')
    submitSearch('second')
    expect(await screen.findByText('newer query result')).toBeInTheDocument()

    resolveFirst?.(response([match(FIRST_MESSAGE_ID, 'stale result', '2026-07-29T13:00:00+00:00')]))
    await waitFor(() => expect(screen.queryByText('stale result')).not.toBeInTheDocument())
    expect(screen.getByText('newer query result')).toBeInTheDocument()
  })
})

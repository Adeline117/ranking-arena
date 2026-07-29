import { act, renderHook, waitFor } from '@testing-library/react'

const mockAuthedFetch = jest.fn()
const mockPush = jest.fn()
const mockShowToast = jest.fn()
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'
const OTHER_USER = '33333333-3333-4333-8333-333333333333'
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444'
const MESSAGE_FROM_OTHER = '55555555-5555-4555-8555-555555555555'
const MESSAGE_FROM_VIEWER = '66666666-6666-4666-8666-666666666666'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'pending' | 'anon' | `user:${string}`
}

type ViewerSnapshot = {
  accessToken: string
  email: string | null
  sessionGeneration: number
  userId: string
  viewerKey: `user:${string}`
}

function signedIn(userId: string, token: string, generation: number): MockAuth {
  return {
    accessToken: token,
    authChecked: true,
    email: `${userId}@example.com`,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

function captureViewer(auth: MockAuth): ViewerSnapshot | null {
  if (
    auth.loading ||
    !auth.authChecked ||
    !auth.userId ||
    !auth.accessToken ||
    auth.viewerKey !== `user:${auth.userId}`
  ) {
    return null
  }
  return {
    accessToken: auth.accessToken,
    email: auth.email,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
    viewerKey: auth.viewerKey,
  }
}

function isViewerCurrent(viewer: ViewerSnapshot, auth: MockAuth): boolean {
  return (
    auth.authChecked &&
    !auth.loading &&
    auth.sessionGeneration === viewer.sessionGeneration &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey
  )
}

function message(id: string, senderId: string, receiverId: string, content = 'hello') {
  return {
    id,
    sender_id: senderId,
    receiver_id: receiverId,
    content,
    read: false,
    created_at: '2026-07-29T12:00:00.000Z',
    reactions: [],
  }
}

function messagesAcknowledgement(viewerId = VIEWER_A) {
  return {
    has_more: false,
    messages: [
      message(MESSAGE_FROM_OTHER, OTHER_USER, viewerId),
      message(MESSAGE_FROM_VIEWER, viewerId, OTHER_USER, 'from viewer'),
    ],
    otherUser: {
      id: OTHER_USER,
      handle: 'counterparty',
      avatar_url: null,
      bio: null,
    },
  }
}

function sendAcknowledgement(
  senderId: string,
  receiverId: string,
  content: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    success: true,
    conversation_id: CONVERSATION_ID,
    message: {
      ...message('77777777-7777-4777-8777-777777777777', senderId, receiverId, content),
      ...overrides,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => captureViewer(auth),
  isSettingsViewerCurrent: (viewer: ViewerSnapshot, auth: MockAuth) =>
    isViewerCurrent(viewer, auth),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/hooks/useRealtime', () => ({
  useRealtime: () => undefined,
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))

import { useConversationMessages } from '../useConversationMessages'

function renderConversation(viewerId = VIEWER_A, accessToken = 'access-token-a') {
  return renderHook(
    ({ token, userId }) =>
      useConversationMessages({
        accessToken: token,
        conversationId: CONVERSATION_ID,
        userId,
      }),
    {
      initialProps: {
        token: accessToken,
        userId: viewerId,
      },
    }
  )
}

async function loadConversation(result: ReturnType<typeof renderConversation>['result']) {
  mockAuthedFetch.mockResolvedValueOnce({
    data: messagesAcknowledgement(),
    ok: true,
    status: 200,
  })
  await act(async () => {
    await result.current.loadMessages()
  })
}

describe('useConversationMessages viewer scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
  })

  it('loads only messages for the captured viewer and counterparty', async () => {
    const { result } = renderConversation()
    await loadConversation(result)

    expect(mockAuthedFetch).toHaveBeenCalledWith(
      `/api/messages?conversationId=${CONVERSATION_ID}`,
      'GET',
      'access-token-a',
      undefined,
      15_000,
      {
        expectedSessionGeneration: 1,
        expectedUserId: VIEWER_A,
        signal: expect.any(AbortSignal),
      }
    )
    expect(result.current.otherUser?.id).toBe(OTHER_USER)
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.loading).toBe(false)
  })

  it('does not let an old account handler send after the viewer changes', async () => {
    const { result, rerender } = renderConversation()
    await loadConversation(result)
    const sendFromViewerA = result.current.handleSend
    mockAuthedFetch.mockClear()

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    rerender({ token: 'access-token-b', userId: VIEWER_B })

    await act(async () => {
      await sendFromViewerA('must not send', null)
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(result.current.messages).toEqual([])
  })

  it('aborts and discards an in-flight send when the viewer changes', async () => {
    const { result, rerender } = renderConversation()
    await loadConversation(result)
    mockAuthedFetch.mockReset()
    const pendingSend = deferred<{
      data: unknown
      ok: boolean
      status: number
    }>()
    mockAuthedFetch.mockReturnValueOnce(pendingSend.promise)

    let send!: Promise<void>
    act(() => {
      send = result.current.handleSend('hello from a', null)
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    const requestScope = mockAuthedFetch.mock.calls[0]?.[5] as {
      expectedSessionGeneration: number
      expectedUserId: string
      signal: AbortSignal
    }
    expect(requestScope).toMatchObject({
      expectedSessionGeneration: 1,
      expectedUserId: VIEWER_A,
    })

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    rerender({ token: 'access-token-b', userId: VIEWER_B })
    expect(requestScope.signal.aborted).toBe(true)

    await act(async () => {
      pendingSend.resolve({
        data: sendAcknowledgement(VIEWER_A, OTHER_USER, 'hello from a'),
        ok: true,
        status: 200,
      })
      await send
    })

    expect(result.current.messages).toEqual([])
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('rejects a successful send acknowledgement for the wrong sender', async () => {
    const { result } = renderConversation()
    await loadConversation(result)
    mockAuthedFetch.mockResolvedValueOnce({
      data: sendAcknowledgement(VIEWER_B, OTHER_USER, 'hello'),
      ok: true,
      status: 200,
    })

    await act(async () => {
      await result.current.handleSend('hello', null)
    })

    expect(result.current.messages.at(-1)?._status).toBe('failed')
    expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('scopes read, reaction, and delete writes to the exact viewer', async () => {
    const { result } = renderConversation()
    await loadConversation(result)
    mockAuthedFetch.mockReset()
    mockAuthedFetch
      .mockResolvedValueOnce({
        data: {
          marked_count: 1,
          ok: true,
          read_at: '2026-07-29T12:01:00.000Z',
        },
        ok: true,
        status: 200,
      })
      .mockResolvedValueOnce({
        data: {
          data: {
            action: 'added',
            counts: { '👍': 1 },
            emoji: '👍',
            userEmojis: ['👍'],
          },
          success: true,
        },
        ok: true,
        status: 200,
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          deleted: true,
          already_deleted: false,
          message_id: MESSAGE_FROM_VIEWER,
          conversation_id: CONVERSATION_ID,
          deleted_at: '2026-07-29T12:02:00+00:00',
          last_message_at: '2026-07-29T12:01:00+00:00',
          last_message_preview: 'hello',
        },
        ok: true,
        status: 200,
      })

    await act(async () => {
      await result.current.markRead()
      await result.current.handleToggleReaction(MESSAGE_FROM_OTHER, '👍')
      await result.current.handleDeleteMessage(MESSAGE_FROM_VIEWER)
    })

    for (const call of mockAuthedFetch.mock.calls) {
      expect(call[2]).toBe('access-token-a')
      expect(call[5]).toMatchObject({
        expectedSessionGeneration: 1,
        expectedUserId: VIEWER_A,
        signal: expect.any(AbortSignal),
      })
    }
    expect(
      result.current.messages.find((item) => item.id === MESSAGE_FROM_OTHER)?.reactions
    ).toEqual([{ count: 1, emoji: '👍', mine: true }])
    expect(result.current.messages.some((item) => item.id === MESSAGE_FROM_VIEWER)).toBe(false)
  })

  it('restores an optimistic delete when the server acknowledges another resource', async () => {
    const { result } = renderConversation()
    await loadConversation(result)
    mockAuthedFetch.mockReset()
    mockAuthedFetch.mockResolvedValueOnce({
      data: {
        success: true,
        deleted: true,
        already_deleted: false,
        message_id: MESSAGE_FROM_OTHER,
        conversation_id: CONVERSATION_ID,
        deleted_at: '2026-07-29T12:02:00+00:00',
        last_message_at: '2026-07-29T12:01:00+00:00',
        last_message_preview: 'hello',
      },
      ok: true,
      status: 200,
    })

    await act(async () => {
      await result.current.handleDeleteMessage(MESSAGE_FROM_VIEWER)
    })

    expect(result.current.messages.some((item) => item.id === MESSAGE_FROM_VIEWER)).toBe(true)
    expect(mockShowToast).toHaveBeenCalledWith('operationFailed', 'error')
  })

  it('uses the captured viewer for retry and voice sends', async () => {
    const { result } = renderConversation()
    await loadConversation(result)
    const failedMessage = {
      ...message('88888888-8888-4888-8888-888888888888', VIEWER_A, OTHER_USER, 'retry'),
      _status: 'failed' as const,
    }
    act(() => {
      result.current.setMessages((previous) => [...previous, failedMessage])
    })
    mockAuthedFetch.mockReset()
    mockAuthedFetch
      .mockResolvedValueOnce({
        data: sendAcknowledgement(VIEWER_A, OTHER_USER, 'retry'),
        ok: true,
        status: 200,
      })
      .mockResolvedValueOnce({
        data: sendAcknowledgement(VIEWER_A, OTHER_USER, '[Voice] voiceMessage (0:02)', {
          media_url: 'https://cdn.example.com/voice.webm',
          media_type: 'file',
          media_name: 'voice-message.webm',
        }),
        ok: true,
        status: 200,
      })

    await act(async () => {
      await result.current.handleRetry(failedMessage)
      await result.current.handleVoiceSent(
        {
          fileName: 'voice-message.webm',
          originalName: 'voice-message.webm',
          type: 'file',
          url: 'https://cdn.example.com/voice.webm',
        },
        2
      )
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    for (const call of mockAuthedFetch.mock.calls) {
      expect(call[0]).toBe('/api/messages')
      expect(call[2]).toBe('access-token-a')
      expect(call[5]).toMatchObject({
        expectedSessionGeneration: 1,
        expectedUserId: VIEWER_A,
      })
    }
  })
})

import { act, renderHook, waitFor } from '@testing-library/react'
import type { DragEvent } from 'react'

const mockShowToast = jest.fn()
const mockGetCsrfHeaders = jest.fn(() => ({ 'x-csrf-token': 'csrf-token' }))
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'

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
    auth.accessToken === viewer.accessToken &&
    auth.sessionGeneration === viewer.sessionGeneration &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey
  )
}

function jsonResponse(value: unknown, status = 200): Response {
  return {
    json: jest.fn().mockResolvedValue(value),
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function dropEvent(file: File): DragEvent {
  return {
    dataTransfer: { files: [file] },
    preventDefault: jest.fn(),
  } as unknown as DragEvent
}

let mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => captureViewer(auth),
  isSettingsViewerCurrent: (viewer: ViewerSnapshot, auth: MockAuth) =>
    isViewerCurrent(viewer, auth),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => mockGetCsrfHeaders(),
}))

import { useFileUpload } from '../useFileUpload'

describe('useFileUpload viewer scope', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('uploads with the captured viewer token and does not trust a client user id', async () => {
    const file = new File(['image'], 'proof.png', { type: 'image/png' })
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        url: 'https://cdn.example.com/proof.png',
        fileName: 'conversation-a/image/proof.png',
        originalName: file.name,
        fileSize: file.size,
        category: 'image',
      })
    )
    globalThis.fetch = fetchMock as typeof fetch

    const { result } = renderHook(() =>
      useFileUpload({
        accessToken: 'access-token-a',
        conversationId: 'conversation-a',
        userId: VIEWER_A,
      })
    )

    await act(async () => {
      await result.current.handleDrop(dropEvent(file))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/upload',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer access-token-a',
          'x-csrf-token': 'csrf-token',
        },
        method: 'POST',
        signal: expect.any(AbortSignal),
      })
    )
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = request.body as FormData
    expect(body.get('conversationId')).toBe('conversation-a')
    expect(body.has('userId')).toBe(false)
    expect(result.current.pendingAttachment).toEqual({
      url: 'https://cdn.example.com/proof.png',
      type: 'image',
      fileName: 'conversation-a/image/proof.png',
      originalName: file.name,
      fileSize: file.size,
    })
    expect(result.current.uploading).toBe(false)
  })

  it('aborts and discards an old upload when the viewer changes', async () => {
    const upload = deferred<Response>()
    const fetchMock = jest.fn().mockReturnValue(upload.promise)
    globalThis.fetch = fetchMock as typeof fetch
    const file = new File(['image'], 'proof.png', { type: 'image/png' })

    const { result, rerender } = renderHook(
      ({ accessToken, conversationId, userId }) =>
        useFileUpload({ accessToken, conversationId, userId }),
      {
        initialProps: {
          accessToken: 'access-token-a',
          conversationId: 'conversation-a',
          userId: VIEWER_A,
        },
      }
    )

    let request!: Promise<void>
    act(() => {
      request = result.current.handleDrop(dropEvent(file))
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    rerender({
      accessToken: 'access-token-b',
      conversationId: 'conversation-b',
      userId: VIEWER_B,
    })
    expect(signal.aborted).toBe(true)

    await act(async () => {
      upload.resolve(
        jsonResponse({
          url: 'https://cdn.example.com/proof.png',
          fileName: 'conversation-a/image/proof.png',
          originalName: file.name,
          fileSize: file.size,
          category: 'image',
        })
      )
      await request
    })

    expect(result.current.pendingAttachment).toBeNull()
    expect(result.current.uploading).toBe(false)
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('rejects an acknowledgement for a different conversation', async () => {
    const file = new File(['image'], 'proof.png', { type: 'image/png' })
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        url: 'https://cdn.example.com/proof.png',
        fileName: 'conversation-b/image/proof.png',
        originalName: file.name,
        fileSize: file.size,
        category: 'image',
      })
    ) as typeof fetch

    const { result } = renderHook(() =>
      useFileUpload({
        accessToken: 'access-token-a',
        conversationId: 'conversation-a',
        userId: VIEWER_A,
      })
    )

    await act(async () => {
      await result.current.handleDrop(dropEvent(file))
    })

    expect(result.current.pendingAttachment).toBeNull()
    expect(mockShowToast).toHaveBeenCalledWith('uploadFailedRetry', 'error')
  })
})

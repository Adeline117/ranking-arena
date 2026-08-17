import { act, renderHook, waitFor } from '@testing-library/react'
import type { DragEvent } from 'react'
import type { MediaAttachment } from '../../components/types'

const mockShowToast = jest.fn()
const mockGetCsrfHeaders = jest.fn(() => ({ 'x-csrf-token': 'csrf-token' }))
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_A = '33333333-3333-4333-8333-333333333333'
const CONVERSATION_B = '44444444-4444-4444-8444-444444444444'
const STORAGE_URL = 'https://project.supabase.co'

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

function uploadAcknowledgement(
  conversationId: string,
  file: File,
  category: 'image' | 'video' | 'file'
) {
  const fileName = `${conversationId}/${category}/123-${file.name}`
  return {
    url: `${STORAGE_URL}/storage/v1/object/sign/chat/${fileName}?token=fresh`,
    fileName,
    originalName: file.name,
    fileType: file.type,
    fileSize: file.size,
    category,
  }
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
  const originalStorageUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
    process.env.NEXT_PUBLIC_SUPABASE_URL = STORAGE_URL
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalStorageUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalStorageUrl
  })

  it('uploads with the captured viewer token and does not trust a client user id', async () => {
    const file = new File(['image'], 'proof.png', { type: 'image/png' })
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(uploadAcknowledgement(CONVERSATION_A, file, 'image')))
    globalThis.fetch = fetchMock as typeof fetch

    const { result } = renderHook(() =>
      useFileUpload({
        accessToken: 'access-token-a',
        conversationId: CONVERSATION_A,
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
    expect(body.get('conversationId')).toBe(CONVERSATION_A)
    expect(body.has('userId')).toBe(false)
    expect(result.current.pendingAttachment).toEqual({
      url: `${STORAGE_URL}/storage/v1/object/sign/chat/${CONVERSATION_A}/image/123-proof.png?token=fresh`,
      type: 'image',
      fileName: `${CONVERSATION_A}/image/123-proof.png`,
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
          conversationId: CONVERSATION_A,
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
      conversationId: CONVERSATION_B,
      userId: VIEWER_B,
    })
    expect(signal.aborted).toBe(true)

    await act(async () => {
      upload.resolve(jsonResponse(uploadAcknowledgement(CONVERSATION_A, file, 'image')))
      await request
    })

    expect(result.current.pendingAttachment).toBeNull()
    expect(result.current.uploading).toBe(false)
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('rejects an acknowledgement for a different conversation', async () => {
    const file = new File(['image'], 'proof.png', { type: 'image/png' })
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(uploadAcknowledgement(CONVERSATION_B, file, 'image'))
      ) as typeof fetch

    const { result } = renderHook(() =>
      useFileUpload({
        accessToken: 'access-token-a',
        conversationId: CONVERSATION_A,
        userId: VIEWER_A,
      })
    )

    await act(async () => {
      await result.current.handleDrop(dropEvent(file))
    })

    expect(result.current.pendingAttachment).toBeNull()
    expect(mockShowToast).toHaveBeenCalledWith('uploadFailedRetry', 'error')
  })

  it('returns a voice attachment without publishing it in the composer', async () => {
    const file = new File(['voice'], 'voice.webm', { type: 'audio/webm' })
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(uploadAcknowledgement(CONVERSATION_A, file, 'file'))
      ) as typeof fetch

    const { result } = renderHook(() =>
      useFileUpload({
        accessToken: 'access-token-a',
        conversationId: CONVERSATION_A,
        userId: VIEWER_A,
      })
    )

    let attachment = null
    await act(async () => {
      attachment = await result.current.uploadFile(file, { publishPending: false })
    })

    expect(attachment).toEqual({
      url: `${STORAGE_URL}/storage/v1/object/sign/chat/${CONVERSATION_A}/file/123-voice.webm?token=fresh`,
      type: 'file',
      fileName: `${CONVERSATION_A}/file/123-voice.webm`,
      originalName: file.name,
      fileSize: file.size,
    })
    expect(result.current.pendingAttachment).toBeNull()
  })

  it('keeps a same-conversation upload single-flight without aborting the first request', async () => {
    const firstFile = new File(['first'], 'first.png', { type: 'image/png' })
    const secondFile = new File(['second'], 'second.png', { type: 'image/png' })
    const upload = deferred<Response>()
    const fetchMock = jest.fn().mockReturnValue(upload.promise)
    globalThis.fetch = fetchMock as typeof fetch

    const { result } = renderHook(() =>
      useFileUpload({
        accessToken: 'access-token-a',
        conversationId: CONVERSATION_A,
        userId: VIEWER_A,
      })
    )

    let firstRequest!: Promise<MediaAttachment | null>
    act(() => {
      firstRequest = result.current.uploadFile(firstFile)
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const firstSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal

    let secondResult: MediaAttachment | null = null
    await act(async () => {
      secondResult = await result.current.uploadFile(secondFile)
    })

    expect(secondResult).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(firstSignal.aborted).toBe(false)
    expect(result.current.uploading).toBe(true)

    await act(async () => {
      upload.resolve(jsonResponse(uploadAcknowledgement(CONVERSATION_A, firstFile, 'image')))
      await firstRequest
    })
    expect(result.current.pendingAttachment?.originalName).toBe(firstFile.name)
    expect(result.current.uploading).toBe(false)
  })
})

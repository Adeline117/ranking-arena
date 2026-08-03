import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockShowToast = jest.fn()
const mockAuthSession: {
  accessToken: string
  authChecked: boolean
  userId: string
  viewerKey: `user:${string}`
  sessionGeneration: number
} = {
  accessToken: 'access-token',
  authChecked: true,
  userId: '11111111-1111-4111-8111-111111111111',
  viewerKey: 'user:11111111-1111-4111-8111-111111111111',
  sessionGeneration: 1,
}

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthSession,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

import BookmarkModal from '../BookmarkModal'

function response(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function renderModal({
  onClose = jest.fn(),
  onSelect = jest.fn(async () => true),
}: {
  onClose?: jest.Mock
  onSelect?: jest.Mock
} = {}) {
  return render(
    <BookmarkModal
      isOpen
      onClose={onClose}
      onSelect={onSelect}
      postId="22222222-2222-4222-8222-222222222222"
    />
  )
}

function folder(id = '33333333-3333-4333-8333-333333333333', name = 'Saved folder') {
  return {
    id,
    name,
    description: null,
    avatar_url: null,
    is_public: false,
    is_default: false,
    post_count: 0,
  }
}

describe('BookmarkModal folder load states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthSession.accessToken = 'access-token'
    mockAuthSession.authChecked = true
    mockAuthSession.userId = '11111111-1111-4111-8111-111111111111'
    mockAuthSession.viewerKey = 'user:11111111-1111-4111-8111-111111111111'
    mockAuthSession.sessionGeneration = 1
    window.scrollTo = jest.fn()
    global.fetch = jest.fn()
  })

  it('keeps loading, retryable failure, and genuine empty states distinct', async () => {
    let resolveInitial!: (value: Response) => void
    let resolveRetry!: (value: Response) => void
    ;(global.fetch as jest.Mock)
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveInitial = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveRetry = resolve
        })
      )

    renderModal()

    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(screen.queryByText('noBookmarkFolders')).not.toBeInTheDocument()

    await act(async () => {
      resolveInitial(response({ error: 'unavailable' }, false))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('loadBookmarksFailed')
    expect(screen.queryByText('noBookmarkFolders')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'newBookmarkFolder' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      resolveRetry(response({ data: { folders: [] } }))
    })

    expect(await screen.findByText('noBookmarkFolders')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'newBookmarkFolder' })).toBeEnabled()
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('treats a malformed successful response as a retryable failure, not an empty list', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(response({ data: {} }))

    renderModal()

    expect(await screen.findByRole('alert')).toHaveTextContent('loadBookmarksFailed')
    expect(screen.queryByText('noBookmarkFolders')).not.toBeInTheDocument()
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('loadBookmarksFailed', 'error'))
  })

  it('treats an unauthorized folder response as a retryable failure', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(response({}, false, 401))

    renderModal()

    expect(await screen.findByRole('alert')).toHaveTextContent('loadBookmarksFailed')
    expect(screen.queryByText('noBookmarkFolders')).not.toBeInTheDocument()
  })

  it('hides viewer A folders immediately and rejects its late response after switching to B', async () => {
    let resolveViewerA!: (value: Response) => void
    ;(global.fetch as jest.Mock)
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveViewerA = resolve
        })
      )
      .mockResolvedValueOnce(
        response({
          data: {
            folders: [
              {
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                name: 'Viewer B folder',
                description: null,
                avatar_url: null,
                is_public: false,
                is_default: false,
                post_count: 0,
              },
            ],
          },
        })
      )

    const view = renderModal()
    expect(screen.getByText('loading')).toBeInTheDocument()

    mockAuthSession.accessToken = 'token-viewer-b'
    mockAuthSession.userId = '22222222-2222-4222-8222-222222222222'
    mockAuthSession.viewerKey = 'user:22222222-2222-4222-8222-222222222222'
    mockAuthSession.sessionGeneration = 2
    view.rerender(
      <BookmarkModal
        isOpen
        onClose={jest.fn()}
        onSelect={jest.fn()}
        postId="22222222-2222-4222-8222-222222222222"
      />
    )

    expect(await screen.findByText('Viewer B folder')).toBeInTheDocument()
    await act(async () => {
      resolveViewerA(
        response({
          data: {
            folders: [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                name: 'Viewer A private folder',
                description: null,
                avatar_url: null,
                is_public: false,
                is_default: false,
                post_count: 1,
              },
            ],
          },
        })
      )
    })

    expect(screen.queryByText('Viewer A private folder')).not.toBeInTheDocument()
    expect(screen.getByText('Viewer B folder')).toBeInTheDocument()
  })

  it('does not append a late viewer A create result after switching to B', async () => {
    const lateCreate = deferred<Response>()
    ;(global.fetch as jest.Mock).mockImplementation((_url: string, options?: RequestInit) => {
      const authorization = (options?.headers as Record<string, string> | undefined)?.Authorization
      if (options?.method === 'POST') return lateCreate.promise
      if (authorization === 'Bearer token-viewer-b') {
        return Promise.resolve(
          response({
            data: {
              folders: [
                {
                  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                  name: 'Viewer B folder',
                  description: null,
                  avatar_url: null,
                  is_public: false,
                  is_default: false,
                  post_count: 0,
                },
              ],
            },
          })
        )
      }
      return Promise.resolve(response({ data: { folders: [] } }))
    })

    const view = renderModal()
    expect(await screen.findByText('noBookmarkFolders')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'newBookmarkFolder' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'bookmarkFolderName' }), {
      target: { value: 'Viewer A private draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'create' }))

    mockAuthSession.accessToken = 'token-viewer-b'
    mockAuthSession.userId = '22222222-2222-4222-8222-222222222222'
    mockAuthSession.viewerKey = 'user:22222222-2222-4222-8222-222222222222'
    mockAuthSession.sessionGeneration = 2
    view.rerender(
      <BookmarkModal
        isOpen
        onClose={jest.fn()}
        onSelect={jest.fn()}
        postId="22222222-2222-4222-8222-222222222222"
      />
    )
    expect(await screen.findByText('Viewer B folder')).toBeInTheDocument()

    await act(async () => {
      lateCreate.resolve(
        response({
          data: {
            folder: {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              name: 'Viewer A private draft',
              description: null,
              avatar_url: null,
              is_public: false,
              is_default: false,
              post_count: 0,
            },
          },
        })
      )
      await lateCreate.promise
    })

    expect(screen.queryByText('Viewer A private draft')).not.toBeInTheDocument()
    expect(screen.getByText('Viewer B folder')).toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalledWith('bookmarkFolderCreated', 'success')
  })

  it('keeps the modal open after a rejected save and closes only after a strict success', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(response({ data: { folders: [folder()] } }))
    const onClose = jest.fn()
    const onSelect = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderModal({ onClose, onSelect })
    const folderButton = await screen.findByRole('button', { name: 'Saved folder' })

    fireEvent.click(folderButton)
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(folderButton)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('coalesces duplicate folder clicks while one save is unresolved', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(response({ data: { folders: [folder()] } }))
    const pendingSave = deferred<boolean>()
    const onClose = jest.fn()
    const onSelect = jest.fn(() => pendingSave.promise)
    renderModal({ onClose, onSelect })
    const folderButton = await screen.findByRole('button', { name: 'Saved folder' })

    fireEvent.click(folderButton)
    fireEvent.click(folderButton)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(folderButton).toHaveAttribute('aria-busy', 'true')

    await act(async () => pendingSave.resolve(true))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not let a late viewer A save close viewer B modal state', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(response({ data: { folders: [folder()] } }))
    const pendingSave = deferred<boolean>()
    const onClose = jest.fn()
    const onSelect = jest.fn(() => pendingSave.promise)
    const view = renderModal({ onClose, onSelect })
    fireEvent.click(await screen.findByRole('button', { name: 'Saved folder' }))

    mockAuthSession.accessToken = 'token-viewer-b'
    mockAuthSession.userId = '22222222-2222-4222-8222-222222222222'
    mockAuthSession.viewerKey = 'user:22222222-2222-4222-8222-222222222222'
    mockAuthSession.sessionGeneration = 2
    view.rerender(
      <BookmarkModal
        isOpen
        onClose={onClose}
        onSelect={onSelect}
        postId="22222222-2222-4222-8222-222222222222"
      />
    )

    await act(async () => pendingSave.resolve(true))
    expect(onClose).not.toHaveBeenCalled()
  })
})

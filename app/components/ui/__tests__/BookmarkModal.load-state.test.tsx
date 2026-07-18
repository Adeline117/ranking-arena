import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockShowToast = jest.fn()
const mockAuthSession = {
  accessToken: 'access-token',
  authChecked: true,
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

function renderModal() {
  return render(
    <BookmarkModal
      isOpen
      onClose={jest.fn()}
      onSelect={jest.fn()}
      postId="22222222-2222-4222-8222-222222222222"
    />
  )
}

describe('BookmarkModal folder load states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthSession.accessToken = 'access-token'
    mockAuthSession.authChecked = true
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
})

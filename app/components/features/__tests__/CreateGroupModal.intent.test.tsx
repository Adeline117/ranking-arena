import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
let mockAuthState: { accessToken: string | null; userId: string | null } = {
  accessToken: 'token-a-1',
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/ModalOverlay', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))
jest.mock('@/app/components/ui/Avatar', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/app/components/ui/LoadingSpinner', () => ({
  ButtonSpinner: () => null,
}))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))

import CreateGroupModal from '../CreateGroupModal'

type FetchResult = {
  ok: boolean
  json: () => Promise<unknown>
}

const fetchMock = jest.fn<Promise<FetchResult>, Parameters<typeof fetch>>()

function failedRequest(): Promise<FetchResult> {
  return Promise.reject(new Error('response lost'))
}

function creationAcknowledgement(
  channelId: string,
  actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
) {
  return {
    channel: {
      id: channelId,
      name: 'Stable group',
      type: 'group',
      created_by: actorId,
      avatar_url: null,
      description: null,
      conversation_id: null,
      last_message_at: '2026-08-03T12:00:00.000Z',
      last_message_preview: null,
      created_at: '2026-08-03T12:00:00.000Z',
      updated_at: '2026-08-03T12:00:00.000Z',
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

function requestBodies() {
  return fetchMock.mock.calls
    .filter(([input]) => input === '/api/channels')
    .map(([, init]) => JSON.parse(String(init?.body)) as { channelId: string })
}

async function prepareUnchangedGroup() {
  fireEvent.change(screen.getByRole('textbox', { name: 'searchUsers' }), {
    target: { value: 'member' },
  })
  await act(async () => {
    jest.advanceTimersByTime(300)
    await Promise.resolve()
    await Promise.resolve()
  })
  fireEvent.click(screen.getByRole('button', { name: 'member' }))
  fireEvent.click(screen.getByRole('button', { name: 'next' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'groupName' }), {
    target: { value: 'Stable group' },
  })
}

async function submitGroup() {
  fireEvent.click(screen.getByRole('button', { name: 'createGroup' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'createGroup' })).toBeEnabled())
}

describe('CreateGroupModal creation intent', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    mockAuthState = {
      accessToken: 'token-a-1',
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }
    fetchMock.mockImplementation((input) => {
      if (input === '/api/channels') return failedRequest()
      return Promise.resolve({
        ok: true,
        json: async () => ({
          users: [
            {
              id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              handle: 'member',
              avatar_url: null,
            },
          ],
        }),
      })
    })
    globalThis.fetch = fetchMock as typeof fetch
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('reuses one UUID across response loss, manual close/reopen and token refresh', async () => {
    const onClose = jest.fn()
    const view = render(<CreateGroupModal isOpen onClose={onClose} />)
    await prepareUnchangedGroup()

    await submitGroup()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    view.rerender(<CreateGroupModal isOpen={false} onClose={onClose} />)
    view.rerender(<CreateGroupModal isOpen onClose={onClose} />)

    await submitGroup()
    mockAuthState = { ...mockAuthState, accessToken: 'token-a-2' }
    view.rerender(<CreateGroupModal isOpen onClose={onClose} />)
    await submitGroup()

    const bodies = requestBodies()
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies.map(({ channelId }) => channelId)).size).toBe(1)
  })

  it('rotates the UUID when the canonical actor changes', async () => {
    const view = render(<CreateGroupModal isOpen onClose={jest.fn()} />)
    await prepareUnchangedGroup()
    await submitGroup()

    mockAuthState = {
      accessToken: 'token-b-1',
      userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }
    view.rerender(<CreateGroupModal isOpen onClose={jest.fn()} />)
    await submitGroup()

    const bodies = requestBodies()
    expect(bodies).toHaveLength(2)
    expect(bodies[1].channelId).not.toBe(bodies[0].channelId)
  })

  it('retains on a wrong acknowledgement, clears on exact success and requires a stable actor', async () => {
    const onClose = jest.fn()
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        users: [
          {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            handle: 'member',
            avatar_url: null,
          },
        ],
      }),
    }))
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ channel: { id: 'wrong-channel', type: 'group' } }),
    }))
    fetchMock.mockImplementationOnce(async (_input, init) => ({
      ok: true,
      json: async () =>
        creationAcknowledgement(
          (JSON.parse(String(init?.body)) as { channelId: string }).channelId
        ),
    }))
    fetchMock.mockImplementationOnce(() => failedRequest())

    const view = render(<CreateGroupModal isOpen onClose={onClose} />)
    await prepareUnchangedGroup()
    await submitGroup()
    fireEvent.click(screen.getByRole('button', { name: 'createGroup' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    view.rerender(<CreateGroupModal isOpen onClose={onClose} />)
    await submitGroup()

    const wrongSuccessAndRetry = requestBodies()
    expect(wrongSuccessAndRetry).toHaveLength(3)
    expect(wrongSuccessAndRetry[1].channelId).toBe(wrongSuccessAndRetry[0].channelId)
    expect(wrongSuccessAndRetry[2].channelId).not.toBe(wrongSuccessAndRetry[1].channelId)

    mockAuthState = { accessToken: 'token-pending', userId: null }
    view.rerender(<CreateGroupModal isOpen onClose={onClose} />)
    await submitGroup()
    expect(requestBodies()).toHaveLength(3)
    expect(mockShowToast).toHaveBeenLastCalledWith('createGroupFailed', 'error')
  })

  it('ignores an older member search after a newer query has rendered', async () => {
    const oldSearch = deferred<FetchResult>()
    fetchMock.mockImplementation((input) => {
      const url = String(input)
      if (url.includes('q=old')) return oldSearch.promise
      if (url.includes('q=new')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            users: [
              {
                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                handle: 'new-member',
                avatar_url: null,
              },
            ],
          }),
        })
      }
      return failedRequest()
    })

    render(<CreateGroupModal isOpen onClose={jest.fn()} />)
    const input = screen.getByRole('textbox', { name: 'searchUsers' })
    fireEvent.change(input, { target: { value: 'old' } })
    await act(async () => {
      jest.advanceTimersByTime(300)
      await Promise.resolve()
    })
    fireEvent.change(input, { target: { value: 'new' } })
    await act(async () => {
      jest.advanceTimersByTime(300)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'new-member' })).toBeInTheDocument()

    oldSearch.resolve({
      ok: true,
      json: async () => ({
        users: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            handle: 'old-member',
            avatar_url: null,
          },
        ],
      }),
    })
    await act(async () => {
      await oldSearch.promise
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: 'old-member' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'new-member' })).toBeInTheDocument()
  })

  it('does not navigate when an exact creation response arrives after the modal closes', async () => {
    const createRequest = deferred<FetchResult>()
    fetchMock.mockImplementation((input) => {
      if (input === '/api/channels') return createRequest.promise
      return Promise.resolve({
        ok: true,
        json: async () => ({
          users: [
            {
              id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              handle: 'member',
              avatar_url: null,
            },
          ],
        }),
      })
    })

    const onClose = jest.fn()
    render(<CreateGroupModal isOpen onClose={onClose} />)
    await prepareUnchangedGroup()
    fireEvent.click(screen.getByRole('button', { name: 'createGroup' }))
    const body = requestBodies()[0]
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    createRequest.resolve({
      ok: true,
      json: async () => creationAcknowledgement(body.channelId),
    })
    await act(async () => {
      await createRequest.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('groupCreated', 'success')
  })
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const ACTOR_A = '10000000-0000-4000-8000-000000000001'
const ACTOR_B = '10000000-0000-4000-8000-000000000002'
const COLLECTION_ID = '20000000-0000-4000-8000-000000000001'
const ITEM_ROW_ID = '30000000-0000-4000-8000-000000000001'
const POST_A = '40000000-0000-4000-8000-000000000001'
const POST_B = '40000000-0000-4000-8000-000000000002'

type MockAuth = {
  accessToken: string
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string
  viewerKey: `user:${string}`
}

function signedIn(userId: string, generation: number): MockAuth {
  return {
    accessToken: `token-${userId}-${generation}`,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth = signedIn(ACTOR_A, 1)
const mockAuthedFetch = jest.fn()
const mockShowToast = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))
jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => ({
    accessToken: auth.accessToken,
    email: auth.email,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
    viewerKey: auth.viewerKey,
  }),
  isSettingsViewerCurrent: (
    viewer: { sessionGeneration: number; userId: string; viewerKey: string },
    auth: MockAuth
  ) =>
    viewer.userId === auth.userId &&
    viewer.viewerKey === auth.viewerKey &&
    viewer.sessionGeneration === auth.sessionGeneration,
}))
jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))
jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    Text: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span {...props}>{children}</span>
    ),
  }
})

import AddToCollectionButton from '../AddToCollectionButton'

function success(data: Record<string, unknown>) {
  return {
    success: true,
    data,
    meta: { timestamp: '2026-08-03T12:00:00.000Z' },
  }
}

function result(data: unknown, status = 200) {
  return { data, ok: status >= 200 && status < 300, status }
}

function listAcknowledgement(viewerId = ACTOR_A) {
  return success({
    viewerId,
    collections: [{ id: COLLECTION_ID, name: 'Signals', item_count: 2 }],
  })
}

function addAcknowledgement(itemId = POST_A, actorId = ACTOR_A) {
  return success({
    action: 'add',
    actorId,
    collectionId: COLLECTION_ID,
    itemId,
    itemType: 'post',
    item: {
      id: ITEM_ROW_ID,
      collection_id: COLLECTION_ID,
      item_id: itemId,
      item_type: 'post',
      note: null,
      added_at: '2026-08-03T12:00:00.000Z',
    },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function renderButton(itemId = POST_A) {
  return render(<AddToCollectionButton itemType="post" itemId={itemId} />)
}

async function openExactList() {
  fireEvent.click(screen.getByRole('button', { name: 'collectionSaveTo' }))
  expect(await screen.findByRole('menuitem', { name: /Signals/ })).toBeInTheDocument()
}

describe('AddToCollectionButton identity and request isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(ACTOR_A, 1)
  })

  it('keeps a malformed 2xx out of the empty state and retries explicitly', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(result(success({ viewerId: ACTOR_A, collections: 'invalid' })))
      .mockResolvedValueOnce(result(listAcknowledgement()))

    renderButton()
    fireEvent.click(screen.getByRole('button', { name: 'collectionSaveTo' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('operationFailed')
    expect(screen.queryByText('collectionEmpty')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(await screen.findByRole('menuitem', { name: /Signals/ })).toBeInTheDocument()
  })

  it('retains the last good list when a later refresh fails', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(result(listAcknowledgement()))
      .mockResolvedValueOnce(result({ success: true }, 200))

    renderButton()
    await openExactList()
    fireEvent.click(screen.getByRole('button', { name: 'collectionSaveTo' }))
    fireEvent.click(screen.getByRole('button', { name: 'collectionSaveTo' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Signals/ })).toBeInTheDocument()
    expect(screen.queryByText('collectionEmpty')).not.toBeInTheDocument()
  })

  it('uses synchronous locks for list and add double clicks', async () => {
    const listRequest = deferred<ReturnType<typeof result>>()
    const addRequest = deferred<ReturnType<typeof result>>()
    mockAuthedFetch
      .mockImplementationOnce(() => listRequest.promise)
      .mockImplementationOnce(() => addRequest.promise)

    renderButton()
    const trigger = screen.getByRole('button', { name: 'collectionSaveTo' })
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      listRequest.resolve(result(listAcknowledgement()))
      await listRequest.promise
    })
    const collection = await screen.findByRole('menuitem', { name: /Signals/ })
    fireEvent.click(collection)
    fireEvent.click(collection)
    expect(mockAuthedFetch.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(1)

    await act(async () => {
      addRequest.resolve(result(addAcknowledgement()))
      await addRequest.promise
    })
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('collectionAddedSuccess', 'success')
    )
  })

  it('rejects a 2xx add acknowledgement for another collection resource', async () => {
    mockAuthedFetch.mockResolvedValueOnce(result(listAcknowledgement())).mockResolvedValueOnce(
      result(
        success({
          ...addAcknowledgement().data,
          collectionId: '50000000-0000-4000-8000-000000000001',
        })
      )
    )

    renderButton()
    await openExactList()
    fireEvent.click(screen.getByRole('menuitem', { name: /Signals/ }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('collectionAddFailed', 'error'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalledWith('collectionAddedSuccess', 'success')
  })

  it('drops an old add response after the rendered post changes', async () => {
    const addRequest = deferred<ReturnType<typeof result>>()
    mockAuthedFetch
      .mockResolvedValueOnce(result(listAcknowledgement()))
      .mockImplementationOnce(() => addRequest.promise)

    const view = renderButton(POST_A)
    await openExactList()
    fireEvent.click(screen.getByRole('menuitem', { name: /Signals/ }))
    view.rerender(<AddToCollectionButton itemType="post" itemId={POST_B} />)

    await act(async () => {
      addRequest.resolve(result(addAcknowledgement(POST_A)))
      await addRequest.promise
    })
    expect(mockShowToast).not.toHaveBeenCalledWith('collectionAddedSuccess', 'success')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('drops an old private list after the viewer changes', async () => {
    const listRequest = deferred<ReturnType<typeof result>>()
    mockAuthedFetch.mockImplementationOnce(() => listRequest.promise)

    const view = renderButton()
    fireEvent.click(screen.getByRole('button', { name: 'collectionSaveTo' }))
    mockAuth = signedIn(ACTOR_B, 2)
    view.rerender(<AddToCollectionButton itemType="post" itemId={POST_A} />)

    await act(async () => {
      listRequest.resolve(result(listAcknowledgement(ACTOR_A)))
      await listRequest.promise
    })
    expect(screen.queryByRole('menuitem', { name: /Signals/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { __resetGroupApplicationOperationsForTests } from '@/lib/groups/application-operation'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import GroupManagePage from '../page'

const mockAuthedFetch = jest.fn()
const mockFetch = jest.fn()
const mockShowDangerConfirm = jest.fn()
const mockUseAuthSession = jest.fn()
const mockSupabaseFrom = jest.fn()
const showToast = jest.fn()
let mockIsPro = true
let mockGroupPremium = false

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
  useRouter: () => ({ push: jest.fn() }),
}))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
jest.mock('@/lib/features', () => ({ features: { social: true } }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))
jest.mock('@/app/components/home/hooks/useSubscription', () => ({
  useSubscription: () => ({ isPro: mockIsPro }),
}))
jest.mock('@/app/components/ui/Toast', () => ({ useToast: () => ({ showToast }) }))
jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showDangerConfirm: mockShowDangerConfirm }),
}))
jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
  getCsrfHeaders: () => ({}),
}))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))
jest.mock('@/lib/supabase/client', () => ({
  supabase: { from: (...args: unknown[]) => mockSupabaseFrom(...args) },
}))
jest.mock('../components/MemberList', () => ({ __esModule: true, default: () => null }))
jest.mock('../components/ContentManagement', () => ({
  __esModule: true,
  default: (props: {
    onDeletePost(postId: string): void
    onPinPost(postId: string): void
    pinningPost: string | null
  }) => (
    <div>
      <button
        data-testid="content-delete-post"
        onClick={() => props.onDeletePost('66666666-6666-4666-8666-666666666666')}
      >
        delete
      </button>
      <button
        data-testid="content-pin-post"
        onClick={() => props.onPinPost('66666666-6666-4666-8666-666666666666')}
      >
        pin
      </button>
      <span data-testid="content-pin-state">{props.pinningPost ? 'loading' : 'idle'}</span>
    </div>
  ),
}))
jest.mock('../components/ManageModals', () => ({
  MuteModal: () => null,
  NotifyModal: () => null,
}))
jest.mock('../components/GroupSettings', () => ({
  __esModule: true,
  default: (props: {
    editMode: boolean
    editName: string
    editNameEn: string
    setEditMode(value: boolean): void
    setEditName(value: string): void
    setEditNameEn(value: string): void
    submitting: boolean
    onSubmitEdit(): void
  }) => (
    <div>
      <input
        data-testid="profile-edit-name"
        value={props.editName}
        onChange={(event) => props.setEditName(event.target.value)}
      />
      <input
        data-testid="profile-edit-name-en"
        value={props.editNameEn}
        onChange={(event) => props.setEditNameEn(event.target.value)}
      />
      <button data-testid="profile-edit-open" onClick={() => props.setEditMode(true)}>
        open
      </button>
      <button data-testid="profile-edit-submit" onClick={props.onSubmitEdit}>
        submit
      </button>
      <span data-testid="profile-edit-mode">{props.editMode ? 'editing' : 'closed'}</span>
      <span data-testid="profile-edit-loading">{props.submitting ? 'loading' : 'idle'}</span>
    </div>
  ),
}))

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_GROUP_ID = '55555555-5555-4555-8555-555555555555'
const APPLICATION_ID = '44444444-4444-4444-8444-444444444444'

function token(subject: string, marker: string): string {
  const payload = btoa(JSON.stringify({ sub: subject, marker }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signature`
}

function authFor(actorId: string, generation: number, marker: string) {
  return {
    accessToken: token(actorId, marker),
    email: `${actorId}@example.test`,
    sessionGeneration: generation,
    userId: actorId,
    viewerKey: `user:${actorId}` as const,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function operationBody(callIndex: number) {
  return mockAuthedFetch.mock.calls[callIndex][3] as Record<string, unknown> & {
    operation_id: string
  }
}

function submitAck(callIndex: number) {
  const { operation_id, ...payload } = operationBody(callIndex)
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      message: 'submitted',
      operation_id,
      application: {
        id: APPLICATION_ID,
        group_id: GROUP_ID,
        applicant_id: mockAuthedFetch.mock.calls[callIndex][5].expectedUserId,
        ...payload,
        status: 'pending',
        created_at: '2026-07-16T12:00:00.000Z',
      },
    },
  }
}

function installSupabaseMock({ groupError = null }: { groupError?: unknown } = {}) {
  const group = {
    id: GROUP_ID,
    name: 'Existing group',
    name_en: null,
    description: null,
    description_en: null,
    avatar_url: null,
    rules_json: null,
    role_names: null,
    member_count: 1,
    is_premium_only: mockGroupPremium,
    created_by: ACTOR_A,
    created_at: '2026-07-16T00:00:00.000Z',
  }
  mockSupabaseFrom.mockImplementation((table: string) => {
    const builder: Record<string, jest.Mock | ((resolve: (value: unknown) => void) => void)> = {}
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'lt']) {
      builder[method] = jest.fn(() => builder)
    }
    builder.single = jest.fn().mockResolvedValue({
      data: table === 'groups' ? group : null,
      error: table === 'groups' ? groupError : null,
    })
    builder.maybeSingle = jest
      .fn()
      .mockResolvedValue(
        table === 'own_group_memberships'
          ? { data: { role: 'owner' }, error: null }
          : { data: { id: ACTOR_A, handle: 'owner', avatar_url: null }, error: null }
      )
    builder.then = (resolve: (value: unknown) => void) =>
      Promise.resolve(
        table === 'group_member_moderation_directory'
          ? {
              data: [
                {
                  user_id: ACTOR_A,
                  role: 'owner',
                  joined_at: group.created_at,
                  muted_until: null,
                  mute_reason: null,
                },
              ],
              error: null,
            }
          : table === 'user_profiles'
            ? { data: [{ id: ACTOR_A, handle: 'owner', avatar_url: null }], error: null }
            : { data: [], error: null }
      ).then(resolve)
    return builder
  })
}

async function openSettings() {
  await waitFor(() => expect(screen.queryByText('loading')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'groupSettings' }))
  await waitFor(() => expect(screen.getByTestId('profile-edit-name')).toHaveValue('Existing group'))
  fireEvent.click(screen.getByTestId('profile-edit-open'))
}

async function openContent() {
  await waitFor(() => expect(screen.queryByText('loading')).not.toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'contentManagement' }))
  await screen.findByTestId('content-pin-post')
}

describe('group profile edit submit operation', () => {
  let currentAuth: ReturnType<typeof authFor>

  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockReset()
    window.localStorage.clear()
    __resetViewerScopeForTests()
    __resetGroupApplicationOperationsForTests()
    mockIsPro = true
    mockGroupPremium = false
    mockShowDangerConfirm.mockResolvedValue(false)
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: mockFetch })
    installSupabaseMock()
    const scope = synchronizeViewerScope(true, ACTOR_A)
    currentAuth = authFor(ACTOR_A, scope.sessionGeneration, 'a')
    mockUseAuthSession.mockImplementation(() => currentAuth)
  })

  it('single-flights a double submit and sends one canonical NFC snapshot', async () => {
    const response = deferred<ReturnType<typeof submitAck>>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const view = render(<GroupManagePage params={Promise.resolve({ id: GROUP_ID })} />)
    await openSettings()
    fireEvent.change(screen.getByTestId('profile-edit-name'), {
      target: { value: ' Cafe\u0301 😀 ' },
    })

    fireEvent.click(screen.getByTestId('profile-edit-submit'))
    fireEvent.click(screen.getByTestId('profile-edit-submit'))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(operationBody(0)).toEqual(
      expect.objectContaining({
        name: 'Café 😀',
        operation_id: expect.any(String),
      })
    )
    expect(screen.getByTestId('profile-edit-loading')).toHaveTextContent('loading')

    await act(async () => response.resolve(submitAck(0)))
    await waitFor(() =>
      expect(screen.getByTestId('profile-edit-loading')).toHaveTextContent('idle')
    )
    expect(screen.getByTestId('profile-edit-mode')).toHaveTextContent('closed')
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('editRequestSubmitted', 'success')
    view.unmount()
  })

  it('retains an operation after 5xx or invalid ACK and abandons it after explicit 4xx', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: false, status: 503, data: { error: 'down' } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { success: true } })
      .mockResolvedValueOnce({ ok: false, status: 409, data: { error: 'conflict' } })
      .mockResolvedValueOnce({ ok: false, status: 503, data: { error: 'retry' } })
    render(<GroupManagePage params={Promise.resolve({ id: GROUP_ID })} />)
    await openSettings()

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByTestId('profile-edit-submit'))
      await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(index + 1))
      await waitFor(() =>
        expect(screen.getByTestId('profile-edit-loading')).toHaveTextContent('idle')
      )
    }

    expect(operationBody(1).operation_id).toBe(operationBody(0).operation_id)
    expect(operationBody(2).operation_id).toBe(operationBody(0).operation_id)
    expect(operationBody(3).operation_id).not.toBe(operationBody(2).operation_id)
  })

  it('preserves an existing premium flag when the owner is no longer Pro', async () => {
    mockIsPro = false
    mockGroupPremium = true
    installSupabaseMock()
    mockAuthedFetch.mockResolvedValue({ ok: false, status: 503, data: null })
    render(<GroupManagePage params={Promise.resolve({ id: GROUP_ID })} />)
    await openSettings()
    fireEvent.click(screen.getByTestId('profile-edit-submit'))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(operationBody(0).is_premium_only).toBe(true)
  })

  it('keeps the existing primary name for an English-only edit', async () => {
    mockAuthedFetch.mockResolvedValue({ ok: false, status: 503, data: null })
    render(<GroupManagePage params={Promise.resolve({ id: GROUP_ID })} />)
    await openSettings()
    fireEvent.change(screen.getByTestId('profile-edit-name'), { target: { value: ' ' } })
    fireEvent.change(screen.getByTestId('profile-edit-name-en'), {
      target: { value: ' English update ' },
    })
    fireEvent.click(screen.getByTestId('profile-edit-submit'))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(operationBody(0)).toEqual(
      expect.objectContaining({ name: 'Existing group', name_en: 'English update' })
    )
  })

  it('clears the old resource immediately while a replacement params source is pending', async () => {
    const firstParams = Promise.resolve({ id: GROUP_ID })
    const nextParams = deferred<{ id: string }>()
    const view = render(<GroupManagePage params={firstParams} />)
    await openSettings()

    view.rerender(<GroupManagePage params={nextParams.promise} />)
    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(screen.queryByTestId('profile-edit-submit')).not.toBeInTheDocument()

    await act(async () => nextParams.resolve({ id: OTHER_GROUP_ID }))
    await waitFor(() => expect(screen.queryByText('loading')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'groupSettings' })).toBeInTheDocument()
  })

  it('fails closed instead of publishing a partial manager snapshot on any query error', async () => {
    installSupabaseMock({ groupError: { code: 'XX001' } })
    render(<GroupManagePage params={Promise.resolve({ id: GROUP_ID })} />)

    await waitFor(() => expect(screen.queryByText('loading')).not.toBeInTheDocument())
    expect(screen.getByText('noManagePermission')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'groupSettings' })).not.toBeInTheDocument()
  })

  it('re-checks the resource after a danger confirmation before sending the mutation', async () => {
    const confirmation = deferred<boolean>()
    const nextParams = deferred<{ id: string }>()
    mockShowDangerConfirm.mockReturnValue(confirmation.promise)
    const view = render(<GroupManagePage params={Promise.resolve({ id: GROUP_ID })} />)
    await openContent()

    fireEvent.click(screen.getByTestId('content-delete-post'))
    await waitFor(() => expect(mockShowDangerConfirm).toHaveBeenCalledTimes(1))
    view.rerender(<GroupManagePage params={nextParams.promise} />)
    await act(async () => confirmation.resolve(true))

    expect(mockFetch).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('cannot let a G1 mutation response toast or clear G2 mutation ownership', async () => {
    const responseA = deferred<{
      ok: boolean
      headers: Headers
      json(): Promise<{ is_pinned: boolean }>
    }>()
    const responseB = deferred<{
      ok: boolean
      headers: Headers
      json(): Promise<{ is_pinned: boolean }>
    }>()
    mockFetch.mockReturnValueOnce(responseA.promise).mockReturnValueOnce(responseB.promise)
    const paramsA = Promise.resolve({ id: GROUP_ID })
    const paramsB = Promise.resolve({ id: OTHER_GROUP_ID })
    const view = render(<GroupManagePage params={paramsA} />)
    await openContent()

    fireEvent.click(screen.getByTestId('content-pin-post'))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('content-pin-state')).toHaveTextContent('loading')

    view.rerender(<GroupManagePage params={paramsB} />)
    await openContent()
    expect(screen.getByTestId('content-pin-state')).toHaveTextContent('idle')
    fireEvent.click(screen.getByTestId('content-pin-post'))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('content-pin-state')).toHaveTextContent('loading')

    await act(async () =>
      responseA.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ is_pinned: true }),
      })
    )
    expect(screen.getByTestId('content-pin-state')).toHaveTextContent('loading')
    expect(showToast).not.toHaveBeenCalled()

    await act(async () =>
      responseB.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ is_pinned: true }),
      })
    )
    await waitFor(() => expect(screen.getByTestId('content-pin-state')).toHaveTextContent('idle'))
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('pinned', 'success')
  })

  it('cannot let an A acknowledgement mutate, toast, or clear B submission ownership', async () => {
    const responseA = deferred<ReturnType<typeof submitAck>>()
    const responseB = deferred<ReturnType<typeof submitAck>>()
    const params = Promise.resolve({ id: GROUP_ID })
    mockAuthedFetch.mockReturnValueOnce(responseA.promise).mockReturnValueOnce(responseB.promise)
    const view = render(<GroupManagePage params={params} />)
    await openSettings()
    fireEvent.click(screen.getByTestId('profile-edit-submit'))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    currentAuth = authFor(ACTOR_B, scopeB.sessionGeneration, 'b')
    view.rerender(<GroupManagePage params={params} />)
    await openSettings()
    const currentSubmit = screen.getByTestId('profile-edit-submit')
    expect(screen.getByTestId('profile-edit-loading')).toHaveTextContent('idle')
    fireEvent.click(currentSubmit)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('profile-edit-loading')).toHaveTextContent('loading')

    await act(async () => responseA.resolve(submitAck(0)))
    expect(screen.getByTestId('profile-edit-loading')).toHaveTextContent('loading')
    expect(screen.getByTestId('profile-edit-mode')).toHaveTextContent('editing')
    expect(showToast).not.toHaveBeenCalled()

    await act(async () => responseB.resolve(submitAck(1)))
    await waitFor(() =>
      expect(screen.getByTestId('profile-edit-loading')).toHaveTextContent('idle')
    )
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('editRequestSubmitted', 'success')
  })

  it('drops a late completion across an A-to-A session generation change', async () => {
    const response = deferred<ReturnType<typeof submitAck>>()
    const params = Promise.resolve({ id: GROUP_ID })
    mockAuthedFetch.mockReturnValue(response.promise)
    const view = render(<GroupManagePage params={params} />)
    await openSettings()
    fireEvent.click(screen.getByTestId('profile-edit-submit'))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const transition = beginViewerTransition(ACTOR_A)
    const nextScope = commitViewerTransition(transition, ACTOR_A)!
    currentAuth = authFor(ACTOR_A, nextScope.sessionGeneration, 'reauthenticated')
    view.rerender(<GroupManagePage params={params} />)
    await openSettings()
    expect(screen.getByTestId('profile-edit-loading')).toHaveTextContent('idle')

    await act(async () => response.resolve(submitAck(0)))
    expect(showToast).not.toHaveBeenCalled()
    expect(screen.getByTestId('profile-edit-mode')).toHaveTextContent('editing')
  })

  it('keeps the complete render/style/GroupSettings suffix byte-identical', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/groups/[id]/manage/page.tsx'),
      'utf8'
    )
    const suffix = source.slice(source.indexOf('  const inputStyle:'))
    expect(createHash('sha256').update(suffix).digest('hex')).toBe(
      'b8d3f7b5b6c9db6b5c615ddac884e27830e5e912f8292e7dfa2618fca50a5a00'
    )
  })
})

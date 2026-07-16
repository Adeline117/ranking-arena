import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  getViewerScope,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import GroupDetailPage from '../page'

const mockUseAuthSession = jest.fn()
const mockSupabaseFrom = jest.fn()
const mockSupabaseRpc = jest.fn()
const mockLoadPosts = jest.fn()
const mockShowDangerConfirm = jest.fn()
const mockShowToast = jest.fn()
const mockTrackEvent = jest.fn()
const mockTrackInteraction = jest.fn()
const mockSearchParamsGet = jest.fn()
const mockPostSetter = jest.fn()
let mockPosts: Array<Record<string, unknown>> = []
let mockIsPro = true

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
  useSearchParams: () => ({ get: (...args: unknown[]) => mockSearchParamsGet(...args) }),
}))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function DynamicModal({ open }: { open: boolean }) {
      return <span data-testid="pro-upsell">{open ? 'open' : 'closed'}</span>
    },
}))
jest.mock('@/lib/features', () => ({ features: { social: true } }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))
jest.mock('@/app/components/home/hooks/useSubscription', () => ({
  useSubscription: () => ({ isFeaturesUnlocked: mockIsPro }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showDangerConfirm: mockShowDangerConfirm }),
}))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}))
jest.mock('@/lib/tracking', () => ({
  trackInteraction: (...args: unknown[]) => mockTrackInteraction(...args),
}))
jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))
jest.mock('@/lib/utils/avatar-proxy', () => ({ avatarSrc: (value: string) => value }))
jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  },
}))
jest.mock('@/app/components/base', () => ({
  Box: ({
    as: Component = 'div',
    children,
    ...props
  }: React.ComponentProps<'div'> & { as?: string }) => {
    const Element = Component as 'div'
    return <Element {...props}>{children}</Element>
  },
  Text: ({ children, ...props }: React.ComponentProps<'span'>) => (
    <span {...props}>{children}</span>
  ),
}))
jest.mock('@/app/components/ui/Skeleton', () => ({
  GroupCardSkeleton: () => <span>related-loading</span>,
  PostSkeleton: () => <span data-testid="detail-loading">post-loading</span>,
  SkeletonAvatar: () => <span>avatar-loading</span>,
  Skeleton: () => <span>skeleton</span>,
}))
jest.mock('@/app/components/ui/Breadcrumb', () => ({ __esModule: true, default: () => null }))
jest.mock('@/app/components/utils/ErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('@/app/components/ui/PullToRefreshWrapper', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('../ui/GroupHeader', () => ({
  __esModule: true,
  default: (props: {
    group: { name: string }
    groupId: string
    isMember: boolean
    userRole: string | null
    joining: boolean
    onJoin(): void
    onLeave(): void
    onShowGroupInfo(): void
    onShowMembers(): void
  }) => (
    <section>
      <span data-testid="group-name">{props.group.name}</span>
      <span data-testid="group-id">{props.groupId}</span>
      <span data-testid="membership">{props.isMember ? 'member' : 'outsider'}</span>
      <span data-testid="role">{props.userRole || 'none'}</span>
      <span data-testid="joining">{props.joining ? 'joining' : 'idle'}</span>
      <button onClick={props.onJoin}>join</button>
      <button onClick={props.onLeave}>leave</button>
      <button onClick={props.onShowGroupInfo}>info</button>
      <button onClick={props.onShowMembers}>members</button>
    </section>
  ),
}))
jest.mock('../ui/GroupPostList', () => ({
  __esModule: true,
  default: ({ translatedPosts }: { translatedPosts: Record<string, unknown> }) => (
    <span data-testid="translations">{JSON.stringify(translatedPosts)}</span>
  ),
}))
jest.mock('../ui/GroupMembersSection', () => ({
  GroupInfoModal: () => <span data-testid="group-info-modal">info-modal</span>,
  MembersListModal: ({
    members,
    loading,
  }: {
    members: Array<{ handle?: string | null }>
    loading: boolean
  }) => (
    <span data-testid="members-modal">
      {loading ? 'loading-members' : members.map((member) => member.handle).join(',')}
    </span>
  ),
}))
jest.mock('../hooks/useGroupPosts', () => ({
  useGroupPosts: () => ({
    posts: mockPosts,
    sortedPosts: mockPosts,
    loadPosts: mockLoadPosts,
    sortMode: 'latest',
    setSortMode: mockPostSetter,
    viewMode: 'list',
    setViewMode: mockPostSetter,
    hasMorePosts: false,
    loadingMore: false,
    sentinelRef: { current: null },
    editingPost: null,
    setEditingPost: mockPostSetter,
    editTitle: '',
    setEditTitle: mockPostSetter,
    editContent: '',
    setEditContent: mockPostSetter,
    savingEdit: false,
    deletingPost: null,
    likeLoading: {},
    bookmarkLoading: {},
    repostLoading: {},
    showRepostModal: null,
    setShowRepostModal: mockPostSetter,
    repostComment: '',
    setRepostComment: mockPostSetter,
    expandedComments: {},
    comments: {},
    newComment: {},
    setNewComment: mockPostSetter,
    commentLoading: {},
    replyingTo: {},
    setReplyingTo: mockPostSetter,
    replyContent: {},
    setReplyContent: mockPostSetter,
    expandedReplies: {},
    setExpandedReplies: mockPostSetter,
    expandedPosts: {},
    setExpandedPosts: mockPostSetter,
    handleLike: mockPostSetter,
    handleBookmark: mockPostSetter,
    handleRepost: mockPostSetter,
    handleDeletePost: mockPostSetter,
    handleSaveEdit: mockPostSetter,
    handlePinPost: mockPostSetter,
    toggleComments: mockPostSetter,
    submitComment: mockPostSetter,
    submitReply: mockPostSetter,
    getHeatColor: () => 'transparent',
  }),
}))

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const GROUP_1 = '33333333-3333-4333-8333-333333333333'
const GROUP_2 = '44444444-4444-4444-8444-444444444444'

type QueryRequest = {
  table: string
  selected: string
  eq: Record<string, unknown>
  terminal: 'maybeSingle' | 'then'
}

type QueryResult = { data: unknown; error: unknown }

let queryRequests: QueryRequest[] = []
let queryResolver: (request: QueryRequest) => QueryResult | Promise<QueryResult>
let rpcResolver: (name: string, args: Record<string, unknown>) => QueryResult | Promise<QueryResult>
let currentAuth: ReturnType<typeof authFor> | ReturnType<typeof pendingAuth>
let originalFetch: typeof global.fetch

function token(subject: string, marker: string): string {
  const payload = btoa(JSON.stringify({ sub: subject, marker }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signature`
}

function authFor(actorId: string, sessionGeneration: number, marker = actorId) {
  return {
    accessToken: token(actorId, marker),
    authChecked: true,
    email: `${actorId}@example.test`,
    isLoggedIn: true,
    loading: false,
    sessionGeneration,
    user: { id: actorId },
    userId: actorId,
    viewerKey: `user:${actorId}` as const,
  }
}

function pendingAuth(sessionGeneration: number) {
  return {
    accessToken: null,
    authChecked: false,
    email: null,
    isLoggedIn: false,
    loading: true,
    sessionGeneration,
    user: null,
    userId: null,
    viewerKey: 'pending' as const,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

function groupResult(groupId: string, name = `Group ${groupId}`): QueryResult {
  return {
    data: {
      id: groupId,
      name,
      name_en: null,
      description: null,
      description_en: null,
      avatar_url: null,
      member_count: 1,
      created_at: '2026-07-16T00:00:00.000Z',
      created_by: null,
      rules: null,
      rules_json: null,
      is_premium_only: false,
      visibility: 'open',
      dissolved_at: null,
    },
    error: null,
  }
}

function defaultQuery(request: QueryRequest): QueryResult {
  if (request.table === 'groups' && request.terminal === 'maybeSingle') {
    return groupResult(String(request.eq.id))
  }
  if (request.table === 'own_group_memberships') return { data: null, error: null }
  return { data: [], error: null }
}

function installSupabaseBuilder() {
  mockSupabaseFrom.mockImplementation((table: string) => {
    const request = { table, selected: '', eq: {} as Record<string, unknown> }
    const builder: Record<string, unknown> = {}
    builder.select = jest.fn((selected: string) => {
      request.selected = selected
      return builder
    })
    builder.eq = jest.fn((column: string, value: unknown) => {
      request.eq[column] = value
      return builder
    })
    for (const method of ['neq', 'order', 'limit', 'in']) {
      builder[method] = jest.fn(() => builder)
    }
    builder.maybeSingle = jest.fn(() => {
      const captured: QueryRequest = { ...request, eq: { ...request.eq }, terminal: 'maybeSingle' }
      queryRequests.push(captured)
      return Promise.resolve(queryResolver(captured))
    })
    builder.then = (
      resolve: (value: QueryResult) => unknown,
      reject: (reason: unknown) => unknown
    ) => {
      const captured: QueryRequest = { ...request, eq: { ...request.eq }, terminal: 'then' }
      queryRequests.push(captured)
      return Promise.resolve(queryResolver(captured)).then(resolve, reject)
    }
    return builder
  })
  mockSupabaseRpc.mockImplementation((name: string, args: Record<string, unknown>) =>
    Promise.resolve(rpcResolver(name, args))
  )
}

async function resolveParams(source: ReturnType<typeof deferred<{ id: string }>>, groupId: string) {
  await act(async () => {
    source.resolve({ id: groupId })
    await source.promise
  })
}

async function waitForGroup(name: string) {
  await waitFor(() => expect(screen.getByTestId('group-name')).toHaveTextContent(name))
}

describe('group detail viewer and resource ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, ACTOR_A)
    currentAuth = authFor(ACTOR_A, scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
    mockSearchParamsGet.mockReturnValue(null)
    mockIsPro = true
    mockPosts = [
      {
        id: 'post-placeholder',
        group_id: GROUP_1,
        title: '',
        created_at: '2026-07-16T00:00:00.000Z',
      },
    ]
    mockLoadPosts.mockResolvedValue(undefined)
    mockShowDangerConfirm.mockResolvedValue(true)
    queryRequests = []
    queryResolver = defaultQuery
    rpcResolver = (_name, args) => ({
      data: [
        {
          id: `related-${String(args.p_group_id)}`,
          name: `Related ${String(args.p_group_id)}`,
          member_count: 1,
        },
      ],
      error: null,
    })
    installSupabaseBuilder()
    sessionStorage.clear()
    originalFetch = global.fetch
    global.fetch = jest.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('drops stale params, then resets immediately for a same-id params source', async () => {
    const paramsA = deferred<{ id: string }>()
    const paramsB = deferred<{ id: string }>()
    const view = render(<GroupDetailPage params={paramsA.promise} />)
    expect(screen.getAllByTestId('detail-loading').length).toBeGreaterThan(0)

    view.rerender(<GroupDetailPage params={paramsB.promise} />)
    await resolveParams(paramsA, GROUP_1)
    expect(queryRequests.filter((request) => request.table === 'groups')).toHaveLength(0)

    await resolveParams(paramsB, GROUP_2)
    await waitForGroup(`Group ${GROUP_2}`)
    expect(
      queryRequests
        .filter((request) => request.table === 'groups' && request.terminal === 'maybeSingle')
        .map((request) => request.eq.id)
    ).toEqual([GROUP_2])

    fireEvent.click(screen.getByRole('button', { name: 'info' }))
    expect(screen.getByTestId('group-info-modal')).toBeInTheDocument()
    const sameIdParams = deferred<{ id: string }>()
    view.rerender(<GroupDetailPage params={sameIdParams.promise} />)

    expect(screen.queryByTestId('group-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-info-modal')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('detail-loading').length).toBeGreaterThan(0)

    await resolveParams(sameIdParams, GROUP_2)
    await waitForGroup(`Group ${GROUP_2}`)
    expect(
      queryRequests.filter(
        (request) =>
          request.table === 'groups' &&
          request.terminal === 'maybeSingle' &&
          request.eq.id === GROUP_2
      )
    ).toHaveLength(2)
  })

  it('fails empty through A-to-B and pending-to-new-A ownership changes', async () => {
    const params = Promise.resolve({ id: GROUP_1 })
    const view = render(<GroupDetailPage params={params} />)
    await waitForGroup(`Group ${GROUP_1}`)
    fireEvent.click(screen.getByRole('button', { name: 'info' }))

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    currentAuth = authFor(ACTOR_B, scopeB.sessionGeneration)
    view.rerender(<GroupDetailPage params={params} />)
    expect(screen.queryByTestId('group-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-info-modal')).not.toBeInTheDocument()
    await waitForGroup(`Group ${GROUP_1}`)

    const transition = beginViewerTransition(ACTOR_A)
    currentAuth = pendingAuth(transition)
    view.rerender(<GroupDetailPage params={params} />)
    expect(screen.queryByTestId('group-name')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('detail-loading').length).toBeGreaterThan(0)

    const nextA = commitViewerTransition(transition, ACTOR_A)
    expect(nextA).not.toBeNull()
    currentAuth = authFor(ACTOR_A, getViewerScope().sessionGeneration, 'new-a')
    view.rerender(<GroupDetailPage params={params} />)
    await waitForGroup(`Group ${GROUP_1}`)
    expect(screen.getByTestId('membership')).toHaveTextContent('outsider')
  })

  it('stays fail-closed for a mismatched JWT and resumes when its subject is repaired', async () => {
    const generation = currentAuth.sessionGeneration
    const params = Promise.resolve({ id: GROUP_1 })
    const view = render(<GroupDetailPage params={params} />)
    await waitForGroup(`Group ${GROUP_1}`)
    fireEvent.click(screen.getByRole('button', { name: 'info' }))

    currentAuth = authFor(ACTOR_A, generation, 'same-subject-refresh')
    view.rerender(<GroupDetailPage params={params} />)
    expect(screen.getByTestId('group-info-modal')).toBeInTheDocument()
    expect(
      queryRequests.filter(
        (request) => request.table === 'groups' && request.terminal === 'maybeSingle'
      )
    ).toHaveLength(1)

    currentAuth = { ...authFor(ACTOR_A, generation), accessToken: token(ACTOR_B, 'wrong') }
    view.rerender(<GroupDetailPage params={params} />)

    expect(screen.queryByTestId('group-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('group-info-modal')).not.toBeInTheDocument()
    expect(
      queryRequests.filter(
        (request) => request.table === 'groups' && request.terminal === 'maybeSingle'
      )
    ).toHaveLength(1)

    currentAuth = authFor(ACTOR_A, generation, 'repaired')
    view.rerender(<GroupDetailPage params={params} />)
    await waitForGroup(`Group ${GROUP_1}`)
    expect(
      queryRequests.filter(
        (request) => request.table === 'groups' && request.terminal === 'maybeSingle'
      )
    ).toHaveLength(2)
  })

  it('cannot land an old group read or related fallback in the new owner', async () => {
    const oldGroup = deferred<QueryResult>()
    const oldFallback = deferred<QueryResult>()
    let groupReads = 0
    let relatedReads = 0
    queryResolver = (request) => {
      if (request.table === 'groups' && request.terminal === 'maybeSingle') {
        groupReads += 1
        if (groupReads === 1) return oldGroup.promise
        return groupResult(String(request.eq.id), 'Current group')
      }
      if (request.table === 'groups' && request.terminal === 'then') {
        return oldFallback.promise
      }
      return defaultQuery(request)
    }
    rpcResolver = (_name, args) => {
      relatedReads += 1
      if (relatedReads === 1) {
        return { data: null, error: new Error('force old fallback') }
      }
      return {
        data: [{ id: 'current-related', name: `Current related ${String(args.p_group_id)}` }],
        error: null,
      }
    }
    const params1 = Promise.resolve({ id: GROUP_1 })
    const view = render(<GroupDetailPage params={params1} />)
    await waitFor(() => expect(groupReads).toBe(1))
    await waitFor(() =>
      expect(
        queryRequests.filter((request) => request.table === 'groups' && request.terminal === 'then')
      ).toHaveLength(1)
    )

    const params2 = Promise.resolve({ id: GROUP_2 })
    view.rerender(<GroupDetailPage params={params2} />)
    await waitForGroup('Current group')
    await waitFor(() => expect(screen.getByText(`Current related ${GROUP_2}`)).toBeInTheDocument())

    await act(async () => {
      oldGroup.resolve(groupResult(GROUP_1, 'Stale group'))
      oldFallback.resolve({
        data: [{ id: 'stale-related', name: 'Stale related group' }],
        error: null,
      })
      await Promise.all([oldGroup.promise, oldFallback.promise])
    })

    expect(screen.getByTestId('group-name')).toHaveTextContent('Current group')
    expect(screen.getByText(`Current related ${GROUP_2}`)).toBeInTheDocument()
    expect(screen.queryByText('Stale group')).not.toBeInTheDocument()
    expect(screen.queryByText('Stale related group')).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(
      queryRequests.filter((request) => request.table === 'groups' && request.terminal === 'then')
    ).toHaveLength(1)
  })

  it('drops late owner and member-preview profile reads after the group changes', async () => {
    const oldOwner = deferred<QueryResult>()
    const oldPreviews = deferred<QueryResult>()
    queryResolver = (request) => {
      if (
        request.table === 'groups' &&
        request.terminal === 'maybeSingle' &&
        request.eq.id === GROUP_1
      ) {
        const result = groupResult(GROUP_1, 'Old profile group')
        return {
          ...result,
          data: { ...(result.data as Record<string, unknown>), created_by: ACTOR_A },
        }
      }
      if (
        request.table === 'group_member_directory' &&
        request.selected === 'user_id' &&
        request.eq.group_id === GROUP_1
      ) {
        return { data: [{ user_id: ACTOR_B }], error: null }
      }
      if (request.table === 'user_profiles' && request.terminal === 'maybeSingle') {
        return oldOwner.promise
      }
      if (request.table === 'user_profiles' && request.terminal === 'then') {
        return oldPreviews.promise
      }
      return defaultQuery(request)
    }
    const params1 = Promise.resolve({ id: GROUP_1 })
    const view = render(<GroupDetailPage params={params1} />)
    await waitFor(() =>
      expect(queryRequests.filter((request) => request.table === 'user_profiles')).toHaveLength(2)
    )

    const params2 = Promise.resolve({ id: GROUP_2 })
    view.rerender(<GroupDetailPage params={params2} />)
    await waitForGroup(`Group ${GROUP_2}`)
    await act(async () => {
      oldOwner.resolve({ data: { handle: 'stale-owner' }, error: null })
      oldPreviews.resolve({
        data: [{ id: ACTOR_B, handle: 'stale-preview', avatar_url: '/stale.png' }],
        error: null,
      })
      await Promise.all([oldOwner.promise, oldPreviews.promise])
    })

    expect(screen.getByTestId('group-name')).toHaveTextContent(`Group ${GROUP_2}`)
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('does not turn an old posts trigger rejection into new-owner error state or toast', async () => {
    const oldPosts = deferred<void>()
    mockLoadPosts.mockImplementationOnce(() => oldPosts.promise).mockResolvedValue(undefined)
    const params1 = Promise.resolve({ id: GROUP_1 })
    const view = render(<GroupDetailPage params={params1} />)
    await waitFor(() => expect(mockLoadPosts).toHaveBeenCalledTimes(1))

    const params2 = Promise.resolve({ id: GROUP_2 })
    view.rerender(<GroupDetailPage params={params2} />)
    await waitForGroup(`Group ${GROUP_2}`)
    await act(async () => {
      oldPosts.reject(new Error('stale posts failure'))
      await oldPosts.promise.catch(() => undefined)
    })

    expect(screen.getByTestId('group-name')).toHaveTextContent(`Group ${GROUP_2}`)
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('drops late invite auto-join, confirm, and members completions after a resource change', async () => {
    const joinResponse = deferred<Response>()
    const confirm = deferred<boolean>()
    const membersProfileResponse = deferred<QueryResult>()
    queryResolver = (request) => {
      if (
        request.table === 'group_member_directory' &&
        request.selected === 'user_id, role, joined_at'
      ) {
        return {
          data: [{ user_id: ACTOR_A, role: 'owner', joined_at: '2026-07-16T00:00:00.000Z' }],
          error: null,
        }
      }
      if (
        request.table === 'user_profiles' &&
        request.selected === 'id, handle, avatar_url' &&
        request.terminal === 'then'
      ) {
        return membersProfileResponse.promise
      }
      return defaultQuery(request)
    }
    ;(global.fetch as jest.Mock).mockReturnValueOnce(joinResponse.promise)
    mockShowDangerConfirm.mockReturnValueOnce(confirm.promise)
    mockSearchParamsGet.mockImplementation((key: string) =>
      key === 'invite' ? 'invite-for-group-1' : null
    )
    const params1 = Promise.resolve({ id: GROUP_1 })
    const view = render(<GroupDetailPage params={params1} />)
    await waitForGroup(`Group ${GROUP_1}`)

    await waitFor(() => expect(screen.getByTestId('joining')).toHaveTextContent('joining'))
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({
      action: 'join',
      invite_token: 'invite-for-group-1',
    })
    fireEvent.click(screen.getByRole('button', { name: 'members' }))
    expect(screen.getByTestId('members-modal')).toHaveTextContent('loading-members')
    await waitFor(() =>
      expect(
        queryRequests.some(
          (request) =>
            request.table === 'user_profiles' &&
            request.selected === 'id, handle, avatar_url' &&
            request.terminal === 'then'
        )
      ).toBe(true)
    )
    fireEvent.click(screen.getByRole('button', { name: 'leave' }))

    const params2 = deferred<{ id: string }>()
    view.rerender(<GroupDetailPage params={params2.promise} />)
    expect(screen.queryByTestId('group-name')).not.toBeInTheDocument()
    await act(async () => {
      joinResponse.resolve({
        ok: true,
        json: async () => ({ success: true, action: 'joined', member_count: 9 }),
      } as Response)
      confirm.resolve(true)
      membersProfileResponse.resolve({
        data: [{ id: ACTOR_A, handle: 'stale-member', avatar_url: null }],
        error: null,
      })
      await Promise.all([joinResponse.promise, confirm.promise, membersProfileResponse.promise])
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(mockTrackEvent).not.toHaveBeenCalledWith('group_join', expect.anything())

    mockSearchParamsGet.mockReturnValue(null)
    await resolveParams(params2, GROUP_2)
    await waitForGroup(`Group ${GROUP_2}`)
    expect(screen.getByTestId('membership')).toHaveTextContent('outsider')
    expect(screen.getByTestId('joining')).toHaveTextContent('idle')
    expect(screen.queryByTestId('members-modal')).not.toBeInTheDocument()
  })

  it('does not write stale translations to state or sessionStorage', async () => {
    mockPosts = [
      {
        id: 'translated-post',
        group_id: GROUP_1,
        title: '需要翻译',
        content: '内容',
        created_at: '2026-07-16T00:00:00.000Z',
      },
    ]
    const translationData = deferred<Record<string, unknown>>()
    const responseJson = jest.fn(() => translationData.promise)
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: responseJson } as Response)
    const params1 = Promise.resolve({ id: GROUP_1 })
    const view = render(<GroupDetailPage params={params1} />)
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/translate', expect.anything())
    )
    await waitFor(() => expect(responseJson).toHaveBeenCalledTimes(1))

    mockPosts = []
    const params2 = deferred<{ id: string }>()
    view.rerender(<GroupDetailPage params={params2.promise} />)
    await act(async () => {
      translationData.resolve({
        success: true,
        data: {
          results: {
            'translated-post-title': { translatedText: 'translated' },
            'translated-post-content': { translatedText: 'content' },
          },
        },
      })
      await translationData.promise
    })

    expect(sessionStorage.getItem('trans:translated-post:en')).toBeNull()
    expect(mockShowToast).not.toHaveBeenCalled()
    await resolveParams(params2, GROUP_2)
    await waitForGroup(`Group ${GROUP_2}`)
    expect(screen.getByTestId('translations')).toHaveTextContent('{}')
  })

  it('keeps the premium pre-block ahead of the membership request', async () => {
    mockIsPro = false
    queryResolver = (request) => {
      if (request.table === 'groups' && request.terminal === 'maybeSingle') {
        const result = groupResult(String(request.eq.id))
        return {
          ...result,
          data: { ...(result.data as Record<string, unknown>), is_premium_only: true },
        }
      }
      return defaultQuery(request)
    }
    const params = Promise.resolve({ id: GROUP_1 })
    render(<GroupDetailPage params={params} />)
    await waitForGroup(`Group ${GROUP_1}`)

    fireEvent.click(screen.getByRole('button', { name: 'join' }))

    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockTrackEvent).toHaveBeenCalledWith('paywall_blocked', {
      source: 'premium_group_join',
    })
    expect(screen.getByTestId('pro-upsell')).toHaveTextContent('open')
  })
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import MemberList from '../components/MemberList'

const mockUseAuthSession = jest.fn()
const mockFetch = jest.fn()
const mockClipboardWrite = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('next/image', () => ({
  __esModule: true,
  default: () => null,
}))

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const GROUP_1 = '33333333-3333-4333-8333-333333333333'
const GROUP_2 = '44444444-4444-4444-8444-444444444444'

function token(subject: string, marker: string): string {
  const payload = btoa(JSON.stringify({ sub: subject, marker }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signature`
}

function authFor(userId: string, sessionGeneration: number, marker: string) {
  return {
    accessToken: token(userId, marker),
    userId,
    viewerKey: `user:${userId}` as const,
    sessionGeneration,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(data: unknown, ok = true): Response {
  return {
    ok,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => data,
  } as Response
}

function memberProps(input: {
  accessToken: string | null
  groupId?: string
  onKick?: jest.Mock
  setGeneratingInvite?: jest.Mock
  setInviteUrl?: jest.Mock
  setMemberSearch: jest.Mock
  showToast?: jest.Mock
  userId: string | null
}) {
  return {
    members: [
      {
        user_id: ACTOR_B,
        role: 'member' as const,
        handle: 'member-b',
      },
    ],
    groupId: input.groupId ?? GROUP_1,
    userId: input.userId,
    userRole: 'owner' as const,
    isOwner: true,
    canManage: true,
    createdBy: ACTOR_A,
    accessToken: input.accessToken,
    memberSearch: '',
    setMemberSearch: input.setMemberSearch,
    debouncedMemberSearch: '',
    memberPage: 0,
    setMemberPage: jest.fn(),
    memberRoleFilter: 'all' as const,
    setMemberRoleFilter: jest.fn(),
    inviteUrl: null,
    setInviteUrl: input.setInviteUrl ?? jest.fn(),
    generatingInvite: false,
    setGeneratingInvite: input.setGeneratingInvite ?? jest.fn(),
    onMute: jest.fn(),
    onUnmute: jest.fn(),
    onSetRole: jest.fn(),
    onKick: input.onKick ?? jest.fn(),
    onNotifyOpen: jest.fn(),
    setMembers: jest.fn(),
    showToast: input.showToast ?? jest.fn(),
    t: (key: string) => key,
  }
}

function selectKickableMember() {
  const checkboxes = screen.getAllByRole('checkbox')
  fireEvent.click(checkboxes[checkboxes.length - 1])
  expect(screen.getByRole('button', { name: 'batchKick' })).toBeInTheDocument()
}

describe('MemberList viewer and resource ownership', () => {
  let currentAuth: ReturnType<typeof authFor>

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, ACTOR_A)
    currentAuth = authFor(ACTOR_A, scope.sessionGeneration, 'a')
    mockUseAuthSession.mockImplementation(() => currentAuth)
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: mockFetch })
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mockClipboardWrite },
    })
  })

  it('clears selection on same-group params, A-to-A session, group, and pending transitions', () => {
    const sourceA = jest.fn()
    const propsA = memberProps({
      accessToken: currentAuth.accessToken,
      setMemberSearch: sourceA,
      userId: ACTOR_A,
    })
    const view = render(<MemberList {...propsA} />)
    selectKickableMember()

    const propsSameGroupNewSource = { ...propsA, setMemberSearch: jest.fn() }
    view.rerender(<MemberList {...propsSameGroupNewSource} />)
    expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
    selectKickableMember()

    const transition = beginViewerTransition(ACTOR_A)
    const nextScope = commitViewerTransition(transition, ACTOR_A)!
    currentAuth = authFor(ACTOR_A, nextScope.sessionGeneration, 'reauthenticated')
    const propsReauthenticated = {
      ...propsSameGroupNewSource,
      accessToken: currentAuth.accessToken,
    }
    view.rerender(<MemberList {...propsReauthenticated} />)
    expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
    selectKickableMember()

    const propsGroup2 = {
      ...propsReauthenticated,
      groupId: GROUP_2,
      setMemberSearch: jest.fn(),
    }
    view.rerender(<MemberList {...propsGroup2} />)
    expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
    selectKickableMember()

    const pendingGeneration = beginViewerTransition(null)
    currentAuth = {
      accessToken: null,
      userId: null,
      viewerKey: 'pending',
      sessionGeneration: pendingGeneration,
    }
    view.rerender(
      <MemberList {...propsGroup2} accessToken={null} userId={null} setMemberSearch={jest.fn()} />
    )
    expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
  })

  it('dispatches each batch only through the callback owned by that resource', () => {
    const kickA = jest.fn()
    const kickB = jest.fn()
    const propsA = memberProps({
      accessToken: currentAuth.accessToken,
      onKick: kickA,
      setMemberSearch: jest.fn(),
      userId: ACTOR_A,
    })
    const view = render(<MemberList {...propsA} />)
    selectKickableMember()
    fireEvent.click(screen.getByRole('button', { name: 'batchKick' }))
    expect(kickA).toHaveBeenCalledWith(ACTOR_B, 'member-b')

    const propsB = {
      ...propsA,
      groupId: GROUP_2,
      onKick: kickB,
      setMemberSearch: jest.fn(),
    }
    view.rerender(<MemberList {...propsB} />)
    selectKickableMember()
    fireEvent.click(screen.getByRole('button', { name: 'batchKick' }))
    expect(kickA).toHaveBeenCalledTimes(1)
    expect(kickB).toHaveBeenCalledWith(ACTOR_B, 'member-b')
  })

  it('drops old clipboard, toast, and finally writes after A switches to B', async () => {
    const clipboardA = deferred<void>()
    const responseB = deferred<Response>()
    mockClipboardWrite.mockReturnValueOnce(clipboardA.promise).mockResolvedValueOnce(undefined)
    mockFetch
      .mockResolvedValueOnce(response({ invite_url: '/invite/a' }))
      .mockReturnValueOnce(responseB.promise)

    const setInviteA = jest.fn()
    const setGeneratingA = jest.fn()
    const toastA = jest.fn()
    const propsA = memberProps({
      accessToken: currentAuth.accessToken,
      setGeneratingInvite: setGeneratingA,
      setInviteUrl: setInviteA,
      setMemberSearch: jest.fn(),
      showToast: toastA,
      userId: ACTOR_A,
    })
    const view = render(<MemberList {...propsA} />)
    fireEvent.click(screen.getByRole('button', { name: 'inviteLink' }))
    await waitFor(() => expect(mockClipboardWrite).toHaveBeenCalledTimes(1))
    expect(setInviteA).toHaveBeenCalledWith(`${window.location.origin}/invite/a`)
    expect(setGeneratingA.mock.calls).toEqual([[true]])

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    currentAuth = authFor(ACTOR_B, scopeB.sessionGeneration, 'b')
    const setInviteB = jest.fn()
    const setGeneratingB = jest.fn()
    const toastB = jest.fn()
    const propsB = memberProps({
      accessToken: currentAuth.accessToken,
      groupId: GROUP_2,
      setGeneratingInvite: setGeneratingB,
      setInviteUrl: setInviteB,
      setMemberSearch: jest.fn(),
      showToast: toastB,
      userId: ACTOR_B,
    })
    view.rerender(<MemberList {...propsB} />)
    fireEvent.click(screen.getByRole('button', { name: 'inviteLink' }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(setGeneratingB.mock.calls).toEqual([[true]])

    await act(async () => clipboardA.resolve())
    expect(toastA).not.toHaveBeenCalled()
    expect(setGeneratingA.mock.calls).toEqual([[true]])
    expect(setGeneratingB.mock.calls).toEqual([[true]])

    await act(async () => responseB.resolve(response({ invite_url: '/invite/b' })))
    await waitFor(() =>
      expect(setInviteB).toHaveBeenCalledWith(`${window.location.origin}/invite/b`)
    )
    expect(mockClipboardWrite).toHaveBeenLastCalledWith(`${window.location.origin}/invite/b`)
    expect(toastB).toHaveBeenCalledWith('inviteLinkCopied', 'success')
    expect(setGeneratingB.mock.calls).toEqual([[true], [false]])
  })

  it('keeps the complete render, style, and copy suffix byte-identical', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(app)/groups/[id]/manage/components/MemberList.tsx'),
      'utf8'
    )
    const suffix = source.slice(source.indexOf('  return (\n'))
    expect(createHash('sha256').update(suffix).digest('hex')).toBe(
      '361f8d6d68922d527e1a291dd8681dfcd83c0f07e45305f730cec6e3a4d57e21'
    )
  })
})

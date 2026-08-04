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
const ACTOR_C = '55555555-5555-4555-8555-555555555555'
const GROUP_1 = '33333333-3333-4333-8333-333333333333'
const GROUP_2 = '44444444-4444-4444-8444-444444444444'
const INVITE_EXPIRES_AT = '2026-08-10T00:00:00.000Z'

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
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

function response(data: unknown, ok = true): Response {
  return {
    ok,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => data,
  } as Response
}

function inviteAcknowledgement(groupId: string, marker = 'a') {
  const expiresAt = Date.parse(INVITE_EXPIRES_AT)
  const payload = `${groupId}:${expiresAt}:${marker.repeat(32)}:${marker.repeat(64)}`
  const inviteToken = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return {
    success: true as const,
    invite_url: `/groups/${groupId}?invite=${inviteToken}`,
    expires_at: INVITE_EXPIRES_AT,
  }
}

function memberProps(input: {
  accessToken: string | null
  groupId?: string
  members?: Array<{
    user_id: string
    role: 'owner' | 'admin' | 'member'
    handle: string
  }>
  onKick?: jest.Mock
  setGeneratingInvite?: jest.Mock
  setInviteUrl?: jest.Mock
  setMemberSearch: jest.Mock
  showToast?: jest.Mock
  userId: string | null
}) {
  return {
    members: input.members ?? [
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

  it('dispatches each batch only through the callback owned by that resource', async () => {
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
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
    )

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
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
    )
  })

  it('single-flights an invite double-click before the parent loading state commits', async () => {
    const inviteResponse = deferred<Response>()
    mockFetch.mockReturnValue(inviteResponse.promise)
    const setGeneratingInvite = jest.fn()
    const setInviteUrl = jest.fn()
    const showToast = jest.fn()
    render(
      <MemberList
        {...memberProps({
          accessToken: currentAuth.accessToken,
          setGeneratingInvite,
          setInviteUrl,
          setMemberSearch: jest.fn(),
          showToast,
          userId: ACTOR_A,
        })}
      />
    )

    const inviteButton = screen.getByRole('button', { name: 'inviteLink' })
    fireEvent.click(inviteButton)
    fireEvent.click(inviteButton)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith(`/api/groups/${GROUP_1}/invite`, {
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bearer ${currentAuth.accessToken}` }),
      credentials: 'same-origin',
    })
    expect(setGeneratingInvite.mock.calls).toEqual([[true]])

    const acknowledgement = inviteAcknowledgement(GROUP_1)
    await act(async () => inviteResponse.resolve(response(acknowledgement)))
    await waitFor(() => expect(setGeneratingInvite.mock.calls).toEqual([[true], [false]]))
    expect(setInviteUrl).toHaveBeenCalledTimes(1)
    expect(setInviteUrl).toHaveBeenCalledWith(
      `${window.location.origin}${acknowledgement.invite_url}`
    )
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('inviteLinkCopied', 'success')
  })

  it('rejects an otherwise successful invite acknowledgement bound to another group', async () => {
    mockFetch.mockResolvedValue(response(inviteAcknowledgement(GROUP_2, 'b')))
    const setGeneratingInvite = jest.fn()
    const setInviteUrl = jest.fn()
    const showToast = jest.fn()
    render(
      <MemberList
        {...memberProps({
          accessToken: currentAuth.accessToken,
          setGeneratingInvite,
          setInviteUrl,
          setMemberSearch: jest.fn(),
          showToast,
          userId: ACTOR_A,
        })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'inviteLink' }))

    await waitFor(() => expect(setGeneratingInvite).toHaveBeenLastCalledWith(false))
    expect(setInviteUrl).not.toHaveBeenCalled()
    expect(mockClipboardWrite).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('generateFailed', 'error')
  })

  it('single-flights a batch and awaits each kick in selection order before clearing it', async () => {
    const firstKick = deferred<void>()
    const secondKick = deferred<void>()
    const onKick = jest
      .fn()
      .mockReturnValueOnce(firstKick.promise)
      .mockReturnValueOnce(secondKick.promise)
    render(
      <MemberList
        {...memberProps({
          accessToken: currentAuth.accessToken,
          members: [
            { user_id: ACTOR_B, role: 'member', handle: 'member-b' },
            { user_id: ACTOR_C, role: 'member', handle: 'member-c' },
          ],
          onKick,
          setMemberSearch: jest.fn(),
          userId: ACTOR_A,
        })}
      />
    )

    fireEvent.click(screen.getAllByRole('checkbox')[0])
    const batchButton = screen.getByRole('button', { name: 'batchKick' })
    act(() => {
      batchButton.click()
      batchButton.click()
    })

    expect(onKick).toHaveBeenCalledTimes(1)
    expect(onKick).toHaveBeenLastCalledWith(ACTOR_B, 'member-b')
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await act(async () => firstKick.resolve())
    expect(onKick).toHaveBeenCalledTimes(2)
    expect(onKick).toHaveBeenLastCalledWith(ACTOR_C, 'member-c')
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await act(async () => secondKick.resolve())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
    )
  })

  it('keeps a rejected batch selected and releases its single-flight for retry', async () => {
    const failedKick = deferred<void>()
    const retriedFirstKick = deferred<void>()
    const retriedSecondKick = deferred<void>()
    const onKick = jest
      .fn()
      .mockReturnValueOnce(failedKick.promise)
      .mockReturnValueOnce(retriedFirstKick.promise)
      .mockReturnValueOnce(retriedSecondKick.promise)
    const showToast = jest.fn()
    render(
      <MemberList
        {...memberProps({
          accessToken: currentAuth.accessToken,
          members: [
            { user_id: ACTOR_B, role: 'member', handle: 'member-b' },
            { user_id: ACTOR_C, role: 'member', handle: 'member-c' },
          ],
          onKick,
          setMemberSearch: jest.fn(),
          showToast,
          userId: ACTOR_A,
        })}
      />
    )

    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'batchKick' }))
    await act(async () => failedKick.reject(new Error('kick failed')))

    const retryButton = await screen.findByRole('button', { name: 'batchKick' })
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    expect(onKick).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('networkError', 'error')

    fireEvent.click(retryButton)
    expect(onKick).toHaveBeenCalledTimes(2)
    expect(onKick).toHaveBeenLastCalledWith(ACTOR_B, 'member-b')
    await act(async () => retriedFirstKick.resolve())
    expect(onKick).toHaveBeenCalledTimes(3)
    expect(onKick).toHaveBeenLastCalledWith(ACTOR_C, 'member-c')
    await act(async () => retriedSecondKick.resolve())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
    )
  })

  it('cannot let an old group batch dispatch its next target or unlock the new group batch', async () => {
    const firstKickA = deferred<void>()
    const firstKickB = deferred<void>()
    const secondKickB = deferred<void>()
    const kickA = jest.fn().mockReturnValue(firstKickA.promise)
    const kickB = jest
      .fn()
      .mockReturnValueOnce(firstKickB.promise)
      .mockReturnValueOnce(secondKickB.promise)
    const members = [
      { user_id: ACTOR_B, role: 'member' as const, handle: 'member-b' },
      { user_id: ACTOR_C, role: 'member' as const, handle: 'member-c' },
    ]
    const propsA = memberProps({
      accessToken: currentAuth.accessToken,
      members,
      onKick: kickA,
      setMemberSearch: jest.fn(),
      userId: ACTOR_A,
    })
    const view = render(<MemberList {...propsA} />)
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'batchKick' }))
    expect(kickA).toHaveBeenCalledTimes(1)

    const propsB = {
      ...propsA,
      groupId: GROUP_2,
      onKick: kickB,
      setMemberSearch: jest.fn(),
    }
    view.rerender(<MemberList {...propsB} />)
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'batchKick' }))
    expect(kickB).toHaveBeenCalledTimes(1)
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await act(async () => firstKickA.resolve())
    expect(kickA).toHaveBeenCalledTimes(1)
    expect(kickB).toHaveBeenCalledTimes(1)
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '...' })).toBeDisabled()

    await act(async () => firstKickB.resolve())
    expect(kickB).toHaveBeenCalledTimes(2)
    expect(kickB).toHaveBeenLastCalledWith(ACTOR_C, 'member-c')
    await act(async () => secondKickB.resolve())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'batchKick' })).not.toBeInTheDocument()
    )
  })

  it('drops old clipboard, toast, and finally writes after A switches to B', async () => {
    const clipboardA = deferred<void>()
    const responseB = deferred<Response>()
    mockClipboardWrite.mockReturnValueOnce(clipboardA.promise).mockResolvedValueOnce(undefined)
    const acknowledgementA = inviteAcknowledgement(GROUP_1)
    const acknowledgementB = inviteAcknowledgement(GROUP_2, 'b')
    mockFetch
      .mockResolvedValueOnce(response(acknowledgementA))
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
    expect(setInviteA).toHaveBeenCalledWith(
      `${window.location.origin}${acknowledgementA.invite_url}`
    )
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

    await act(async () => responseB.resolve(response(acknowledgementB)))
    await waitFor(() =>
      expect(setInviteB).toHaveBeenCalledWith(
        `${window.location.origin}${acknowledgementB.invite_url}`
      )
    )
    expect(mockClipboardWrite).toHaveBeenLastCalledWith(
      `${window.location.origin}${acknowledgementB.invite_url}`
    )
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
      '2f12cd2908b4c8e6a16a012db0db2f7c18d25851d03d67b86baba15c0831fd5d'
    )
  })
})

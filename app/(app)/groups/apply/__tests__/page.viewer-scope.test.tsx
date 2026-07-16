import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChangeEvent, RefObject } from 'react'

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
jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))
jest.mock('@/app/components/home/hooks/useSubscription', () => ({
  useSubscription: () => ({ isPro: true }),
}))
jest.mock('@/app/components/ui/Toast', () => ({ useToast: jest.fn() }))
jest.mock('@/lib/hooks/useUnsavedChangesGuard', () => ({ useUnsavedChangesGuard: jest.fn() }))
jest.mock('@/lib/api/client', () => ({ authedFetch: jest.fn() }))
jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: { getValidToken: jest.fn() },
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}))
jest.mock('../components/AvatarUploadSection', () => ({
  AvatarUploadSection: ({
    avatarUrl,
    setAvatarUrl,
    uploading,
    fileInputRef,
    onImageUpload,
  }: {
    avatarUrl: string
    setAvatarUrl: (value: string) => void
    uploading: boolean
    fileInputRef: RefObject<HTMLInputElement | null>
    onImageUpload: (event: ChangeEvent<HTMLInputElement>) => void
  }) => (
    <div>
      <input data-testid="avatar-file" ref={fileInputRef} type="file" onChange={onImageUpload} />
      <input
        data-testid="avatar-url"
        value={avatarUrl}
        onChange={(event) => setAvatarUrl(event.target.value)}
      />
      <span data-testid="avatar-uploading">{uploading ? 'uploading' : 'idle'}</span>
    </div>
  ),
}))
jest.mock('../components/ProGroupOption', () => ({
  ProGroupOption: ({
    isPremiumOnly,
    setIsPremiumOnly,
  }: {
    isPremiumOnly: boolean
    setIsPremiumOnly: (value: boolean) => void
  }) => (
    <button
      data-testid="premium-choice"
      type="button"
      onClick={() => setIsPremiumOnly(!isPremiumOnly)}
    >
      {isPremiumOnly ? 'premium' : 'standard'}
    </button>
  ),
}))
jest.mock('../components/RoleNameSettings', () => ({
  RoleNameSettings: ({
    roleNames,
    setRoleNames,
  }: {
    roleNames: { admin: { zh: string; en: string }; member: { zh: string; en: string } }
    setRoleNames: (value: {
      admin: { zh: string; en: string }
      member: { zh: string; en: string }
    }) => void
  }) => (
    <input
      data-testid="admin-role-zh"
      value={roleNames.admin.zh}
      onChange={(event) =>
        setRoleNames({
          ...roleNames,
          admin: { ...roleNames.admin, zh: event.target.value },
        })
      }
    />
  ),
}))

import { useToast } from '@/app/components/ui/Toast'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { authedFetch } from '@/lib/api/client'
import ApplyGroupPage from '../page'

const mockUseAuthSession = useAuthSession as jest.Mock
const mockUseToast = useToast as jest.Mock
const mockAuthedFetch = authedFetch as jest.Mock
const mockGetValidToken = tokenRefreshCoordinator.getValidToken as jest.Mock
const showToast = jest.fn()

function jwt(userId: string, nonce = 'initial'): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId, nonce })}.signature`
}

function authFor(userId: string, sessionGeneration: number) {
  return {
    accessToken: jwt(userId),
    email: `${userId}@example.test`,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function imageFile(name: string): File {
  return new File(['image'], name, { type: 'image/png' })
}

describe('group application viewer ownership', () => {
  let currentAuth: ReturnType<typeof authFor>
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
    mockUseToast.mockReturnValue({ showToast })
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { applications: [] },
    })
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('fails empty for every user-owned draft slot on an account switch', async () => {
    const view = render(<ApplyGroupPage />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByPlaceholderText('groupNameZhPlaceholder'), {
      target: { value: 'A 中文名称' },
    })
    fireEvent.change(screen.getByPlaceholderText('groupDescZhPlaceholder'), {
      target: { value: 'private draft for A' },
    })
    fireEvent.click(screen.getByRole('button', { name: '+ addLanguageBtn' }))
    fireEvent.change(screen.getByPlaceholderText('e.g., BTC Trading Discussion'), {
      target: { value: 'A English name' },
    })
    fireEvent.change(screen.getByPlaceholderText('Describe your group...'), {
      target: { value: 'A English description' },
    })
    const newRuleInput = screen.getByPlaceholderText('ruleInputZhPlaceholder')
    fireEvent.change(newRuleInput, {
      target: { value: 'A-only rule' },
    })
    fireEvent.keyDown(newRuleInput, { key: 'Enter' })
    fireEvent.change(screen.getByPlaceholderText('ruleInputZhPlaceholder'), {
      target: { value: 'unfinished A rule' },
    })
    fireEvent.change(screen.getByPlaceholderText('ruleInputEnPlaceholder'), {
      target: { value: 'unfinished A English rule' },
    })
    fireEvent.change(screen.getByTestId('avatar-url'), { target: { value: 'https://a/avatar' } })
    fireEvent.change(screen.getByTestId('admin-role-zh'), { target: { value: 'A owner' } })
    fireEvent.click(screen.getByTestId('premium-choice'))

    expect(screen.getByDisplayValue('A 中文名称')).toBeInTheDocument()
    expect(screen.getByDisplayValue('private draft for A')).toBeInTheDocument()
    expect(screen.getByDisplayValue('A English name')).toBeInTheDocument()
    expect(screen.getByDisplayValue('A English description')).toBeInTheDocument()
    expect(screen.getByDisplayValue('A-only rule')).toBeInTheDocument()
    expect(screen.getByDisplayValue('unfinished A rule')).toBeInTheDocument()
    expect(screen.getByDisplayValue('unfinished A English rule')).toBeInTheDocument()
    expect(screen.getByTestId('avatar-url')).toHaveValue('https://a/avatar')
    expect(screen.getByTestId('admin-role-zh')).toHaveValue('A owner')
    expect(screen.getByTestId('premium-choice')).toHaveTextContent('premium')

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<ApplyGroupPage />)

    expect(screen.getByPlaceholderText('groupNameZhPlaceholder')).toHaveValue('')
    expect(screen.getByPlaceholderText('groupDescZhPlaceholder')).toHaveValue('')
    expect(screen.queryByDisplayValue('A English name')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('A English description')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('A-only rule')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('ruleInputZhPlaceholder')).toHaveValue('')
    expect(screen.getByTestId('avatar-url')).toHaveValue('')
    expect(screen.getByTestId('admin-role-zh')).toHaveValue('管理员')
    expect(screen.getByTestId('premium-choice')).toHaveTextContent('standard')
    expect(screen.getByTestId('avatar-uploading')).toHaveTextContent('idle')
  })

  it('does not expose A field errors in B slot', () => {
    const view = render(<ApplyGroupPage />)
    fireEvent.blur(screen.getByPlaceholderText('groupNameZhPlaceholder'))
    expect(screen.getByText('nameRequiredError')).toBeInTheDocument()

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<ApplyGroupPage />)

    expect(screen.queryByText('nameRequiredError')).not.toBeInTheDocument()
  })

  it('rejects a mismatched JWT before refreshing a token or sending the file', () => {
    currentAuth = { ...currentAuth, accessToken: jwt('user-b') }
    global.fetch = jest.fn()
    render(<ApplyGroupPage />)

    fireEvent.change(screen.getByTestId('avatar-file'), {
      target: { files: [imageFile('a.png')] },
    })

    expect(mockGetValidToken).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('pleaseLoginFirst', 'warning')
    expect(screen.getByTestId('avatar-uploading')).toHaveTextContent('idle')
  })

  it('binds token refresh to A and drops a token completion after B takes ownership', async () => {
    const token = deferred<string | null>()
    mockGetValidToken.mockReturnValue(token.promise)
    global.fetch = jest.fn()

    const view = render(<ApplyGroupPage />)
    const fileInput = screen.getByTestId('avatar-file')
    fireEvent.change(fileInput, { target: { files: [imageFile('a.png')] } })

    await waitFor(() =>
      expect(mockGetValidToken).toHaveBeenCalledWith({
        expectedUserId: 'user-a',
        sessionGeneration: currentAuth.sessionGeneration,
      })
    )
    expect(screen.getByTestId('avatar-uploading')).toHaveTextContent('uploading')

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<ApplyGroupPage />)
    expect(screen.getByTestId('avatar-uploading')).toHaveTextContent('idle')

    await act(async () => token.resolve(jwt('user-b', 'fresh')))

    expect(global.fetch).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
    expect(screen.getByTestId('avatar-url')).toHaveValue('')
    expect(screen.getByTestId('avatar-uploading')).toHaveTextContent('idle')
  })

  it('cannot land A response/toast/finally into B or clear B upload input', async () => {
    const responseA = deferred<Response>()
    const responseB = deferred<Response>()
    mockGetValidToken.mockImplementation(({ expectedUserId }: { expectedUserId: string }) =>
      Promise.resolve(jwt(expectedUserId, 'fresh'))
    )
    const fetchMock = jest.fn((_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      return authorization === `Bearer ${jwt('user-a', 'fresh')}`
        ? responseA.promise
        : responseB.promise
    })
    global.fetch = fetchMock as typeof global.fetch

    const view = render(<ApplyGroupPage />)
    const fileInput = screen.getByTestId('avatar-file') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [imageFile('a.png')] } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const firstRequest = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(firstRequest.headers).get('authorization')).toBe(
      `Bearer ${jwt('user-a', 'fresh')}`
    )
    expect((firstRequest.body as FormData).get('userId')).toBe('user-a')

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(<ApplyGroupPage />)

    fireEvent.change(fileInput, { target: { files: [imageFile('b.png')] } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(new Headers(secondRequest.headers).get('authorization')).toBe(
      `Bearer ${jwt('user-b', 'fresh')}`
    )
    expect((secondRequest.body as FormData).get('userId')).toBe('user-b')

    await act(async () =>
      responseA.resolve({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://a/avatar' }),
      } as Response)
    )

    expect(screen.getByTestId('avatar-uploading')).toHaveTextContent('uploading')
    expect(fileInput.files?.[0]?.name).toBe('b.png')
    expect(screen.getByTestId('avatar-url')).toHaveValue('')
    expect(showToast).not.toHaveBeenCalled()

    await act(async () =>
      responseB.resolve({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://b/avatar' }),
      } as Response)
    )

    await waitFor(() => expect(screen.getByTestId('avatar-url')).toHaveValue('https://b/avatar'))
    expect(screen.getByTestId('avatar-uploading')).toHaveTextContent('idle')
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('imageUploadSuccess', 'success')
  })
})

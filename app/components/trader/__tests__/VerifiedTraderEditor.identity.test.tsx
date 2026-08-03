import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockShowToast = jest.fn()
const mockOnSaved = jest.fn()
const mockAuthedFetch = jest.fn()
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | 'pending' | `user:${string}`
}

function signedIn(userId: string, token: string, generation: number): MockAuth {
  return {
    accessToken: token,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 'token-a', 1)

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => {
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
  },
  isSettingsViewerCurrent: (
    viewer: { sessionGeneration: number; userId: string; viewerKey: string },
    auth: MockAuth
  ) =>
    auth.authChecked &&
    !auth.loading &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration,
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) =>
      React.createElement('span', props, children),
    Button: ({
      children,
      variant: _variant,
      size: _size,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
      React.createElement('button', props, children),
  }
})

import VerifiedTraderEditor, { type VerifiedTraderProfileData } from '../VerifiedTraderEditor'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function profile(
  values: Omit<VerifiedTraderProfileData, 'profile_version'>,
  profileVersion = 0
): VerifiedTraderProfileData {
  return { profile_version: profileVersion, ...values }
}

function successfulResponse(
  verifiedTrader: VerifiedTraderProfileData & {
    trader_id: string
    source: string
    user_id?: string
  }
): Response {
  const completeProfile = {
    user_id: VIEWER_A,
    display_name: null,
    bio: null,
    twitter_url: null,
    telegram_url: null,
    discord_url: null,
    website_url: null,
    ...verifiedTrader,
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { verified_trader: completeProfile } }),
  } as Response
}

function responseForRequest(_input: unknown, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  const profileVersion = body.profile_version as number
  return successfulResponse({
    profile_version: profileVersion + 1,
    trader_id: body.trader_id as string,
    source: body.source as string,
    display_name: (body.display_name as string | null | undefined) ?? null,
    bio: (body.bio as string | null | undefined) ?? null,
    twitter_url: (body.twitter_url as string | null | undefined) ?? null,
    telegram_url: (body.telegram_url as string | null | undefined) ?? null,
    discord_url: (body.discord_url as string | null | undefined) ?? null,
    website_url: (body.website_url as string | null | undefined) ?? null,
  })
}

async function authedFetchThroughBrowserFetch(
  url: string,
  method: string,
  accessToken: string,
  body: Record<string, unknown> | undefined,
  _timeoutMs: number,
  scope: { signal?: AbortSignal }
) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: scope.signal,
  })
  return {
    ok: response.ok,
    status: response.status,
    data: await response.json().catch(() => null),
  }
}

describe('VerifiedTraderEditor identity contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'token-a', 1)
    mockAuthedFetch.mockImplementation(authedFetchThroughBrowserFetch)
    global.fetch = jest.fn().mockImplementation(responseForRequest)
  })

  it('sends only the changed field with the exact trader identity', async () => {
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({
          display_name: 'Before',
          bio: 'Existing bio',
          twitter_url: 'https://x.com/existing',
          telegram_url: 'https://t.me/existing',
          discord_url: 'existing-user',
          website_url: 'https://example.com',
        })}
        onSaved={mockOnSaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'After' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(JSON.parse(String(init.body))).toEqual({
      trader_id: 'account-42',
      source: 'binance_futures',
      profile_version: 0,
      display_name: 'After',
    })
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/traders/claim/profile',
      'PUT',
      'token-a',
      {
        trader_id: 'account-42',
        source: 'binance_futures',
        profile_version: 0,
        display_name: 'After',
      },
      20_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )
    expect(mockOnSaved).toHaveBeenCalledTimes(1)
  })

  it('sends null only when the user explicitly clears a field', async () => {
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Existing name', bio: 'Existing bio' })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderBio'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(JSON.parse(String(init.body))).toEqual({
      trader_id: 'account-42',
      source: 'binance_futures',
      profile_version: 0,
      bio: null,
    })
  })

  it('does not write when nothing changed', () => {
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Existing name', bio: 'Existing bio' })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'verifiedTraderEditProfile' })).toBeInTheDocument()
  })

  it('keeps an active draft during revalidation, then cancel and reopen use latest data', () => {
    const view = render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Before', bio: 'Before bio' })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'Unsaved draft' },
    })

    view.rerender(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Fresh server value', bio: 'Fresh server bio' }, 1)}
      />
    )
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Unsaved draft')

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))

    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Fresh server value')
    expect(screen.getByLabelText('verifiedTraderBio')).toHaveValue('Fresh server bio')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('adopts exact profile data that arrives before editing starts', () => {
    const view = render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({})}
      />
    )

    view.rerender(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Loaded name', bio: 'Loaded bio' }, 2)}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))

    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Loaded name')
    expect(screen.getByLabelText('verifiedTraderBio')).toHaveValue('Loaded bio')
  })

  it('closes an old draft and adopts the new profile when trader identity changes', () => {
    const view = render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Account 42', bio: 'First account' })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'Old account draft' },
    })

    view.rerender(
      <VerifiedTraderEditor
        traderId="account-99"
        source="bybit"
        currentData={profile({ display_name: 'Account 99', bio: 'Second account' }, 4)}
      />
    )

    expect(screen.getByRole('button', { name: 'verifiedTraderEditProfile' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Account 99')
    expect(screen.getByLabelText('verifiedTraderBio')).toHaveValue('Second account')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('merges a successful dirty save onto profile data refreshed while the request is pending', async () => {
    const pendingSave = deferred<Response>()
    global.fetch = jest.fn().mockReturnValueOnce(pendingSave.promise)
    const view = render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Before', bio: 'Old server bio' })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'Saved name' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    view.rerender(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Before', bio: 'Fresh server bio' })}
      />
    )
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Saved name')

    await act(async () =>
      pendingSave.resolve(
        successfulResponse({
          trader_id: 'account-42',
          source: 'binance_futures',
          profile_version: 1,
          display_name: 'Saved name',
          bio: 'Fresh server bio',
        })
      )
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'verifiedTraderEditProfile' })).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Saved name')
    expect(screen.getByLabelText('verifiedTraderBio')).toHaveValue('Fresh server bio')
  })

  it('ignores a deferred old response without clearing or closing the new identity save', async () => {
    const oldSave = deferred<Response>()
    const newSave = deferred<Response>()
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newSave.promise)

    const view = render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Account 42' })}
        onSaved={mockOnSaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'Old save' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    view.rerender(
      <VerifiedTraderEditor
        traderId="account-99"
        source="bybit"
        currentData={profile({ display_name: 'Account 99' })}
        onSaved={mockOnSaved}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'New save' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))

    await act(async () =>
      oldSave.resolve(
        successfulResponse({
          trader_id: 'account-42',
          source: 'binance_futures',
          profile_version: 1,
          display_name: 'Old save',
        })
      )
    )

    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('New save')
    expect(screen.getByRole('button', { name: /verifiedTraderSaving/ })).toBeDisabled()
    expect(mockOnSaved).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()

    await act(async () =>
      newSave.resolve(
        successfulResponse({
          trader_id: 'account-99',
          source: 'bybit',
          profile_version: 1,
          display_name: 'New save',
        })
      )
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'verifiedTraderEditProfile' })).toBeInTheDocument()
    )
    expect(mockOnSaved).toHaveBeenCalledTimes(1)
    expect(mockShowToast).toHaveBeenCalledTimes(1)

    const oldRequest = JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body))
    const newRequest = JSON.parse(String((global.fetch as jest.Mock).mock.calls[1][1].body))
    expect(oldRequest).toMatchObject({
      trader_id: 'account-42',
      source: 'binance_futures',
      profile_version: 0,
    })
    expect(newRequest).toMatchObject({
      trader_id: 'account-99',
      source: 'bybit',
      profile_version: 0,
    })
  })

  it('clears A draft, aborts A write, and ignores its response after A to B switch', async () => {
    const oldSave = deferred<Response>()
    global.fetch = jest.fn().mockReturnValueOnce(oldSave.promise)
    const view = render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Account 42' })}
        onSaved={mockOnSaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'A private draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    const oldSignal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal
    expect(oldSignal.aborted).toBe(false)

    mockAuth = signedIn(VIEWER_B, 'token-b', 2)
    view.rerender(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Account 42' })}
        onSaved={mockOnSaved}
      />
    )
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByDisplayValue('A private draft')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Account 42')

    await act(async () =>
      oldSave.resolve(
        successfulResponse({
          user_id: VIEWER_A,
          trader_id: 'account-42',
          source: 'binance_futures',
          profile_version: 1,
          display_name: 'A private draft',
        })
      )
    )

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(mockOnSaved).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Account 42')
  })

  it('closes the same-tick double-click window before saving state renders', async () => {
    const pendingSave = deferred<Response>()
    global.fetch = jest.fn().mockReturnValue(pendingSave.promise)
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Before' })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'One save only' },
    })
    const saveButton = screen.getByRole('button', { name: 'verifiedTraderSaveChanges' })
    act(() => {
      saveButton.click()
      saveButton.click()
    })

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the stale draft open when the database rejects its revision', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: { code: 'DUPLICATE_ACTION', message: 'Profile changed' },
      }),
    })
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Before' }, 5)}
        onSaved={mockOnSaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'Preserved stale draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('verifiedTraderSaveConflict', 'error')
    )
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Preserved stale draft')
    expect(mockOnSaved).not.toHaveBeenCalled()
    const [, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(JSON.parse(String(init.body))).toMatchObject({ profile_version: 5 })
  })

  it('does not report success for a mismatched database acknowledgement', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      successfulResponse({
        trader_id: 'account-42',
        source: 'bybit',
        profile_version: 1,
        display_name: 'Draft',
      })
    )
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Before' })}
        onSaved={mockOnSaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'Draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringContaining('verifiedTraderSaveFailed'),
        'error'
      )
    )
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Draft')
    expect(mockOnSaved).not.toHaveBeenCalled()
  })

  it('does not report success when the acknowledgement belongs to another viewer', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      successfulResponse({
        user_id: VIEWER_B,
        trader_id: 'account-42',
        source: 'binance_futures',
        profile_version: 1,
        display_name: 'Draft',
      })
    )
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Before' })}
        onSaved={mockOnSaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'Draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringContaining('verifiedTraderSaveFailed'),
        'error'
      )
    )
    expect(screen.getByLabelText('verifiedTraderDisplayName')).toHaveValue('Draft')
    expect(mockOnSaved).not.toHaveBeenCalled()
  })

  it('uses the acknowledged revision for a later save without a page reload', async () => {
    render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Before' })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'First save' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'verifiedTraderEditProfile' })).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderBio'), {
      target: { value: 'Second save' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))

    const secondRequest = JSON.parse(String((global.fetch as jest.Mock).mock.calls[1][1].body))
    expect(secondRequest).toMatchObject({
      trader_id: 'account-42',
      source: 'binance_futures',
      profile_version: 1,
      bio: 'Second save',
    })
  })

  it('ignores a deferred response after the editor unmounts', async () => {
    const pendingSave = deferred<Response>()
    global.fetch = jest.fn().mockReturnValueOnce(pendingSave.promise)
    const view = render(
      <VerifiedTraderEditor
        traderId="account-42"
        source="binance_futures"
        currentData={profile({ display_name: 'Account 42' })}
        onSaved={mockOnSaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderEditProfile' }))
    fireEvent.change(screen.getByLabelText('verifiedTraderDisplayName'), {
      target: { value: 'Pending save' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'verifiedTraderSaveChanges' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    view.unmount()
    await act(async () =>
      pendingSave.resolve(
        successfulResponse({
          trader_id: 'account-42',
          source: 'binance_futures',
          profile_version: 1,
          display_name: 'Pending save',
        })
      )
    )

    expect(mockOnSaved).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})

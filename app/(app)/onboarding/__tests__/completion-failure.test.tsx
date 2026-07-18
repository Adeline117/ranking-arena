import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const USER_ID = '10000000-0000-4000-8000-000000000001'
const GROUP_ID = '20000000-0000-4000-8000-000000000002'

const mockGetUser = jest.fn()
const mockGetSession = jest.fn()
const mockMaybeSingle = jest.fn()
const mockUpdateEq = jest.fn()
const mockShowToast = jest.fn()
const mockLoadTraders = jest.fn()
const mockLoadGroups = jest.fn()
const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: mockReplace,
  }),
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: (...args: unknown[]) => mockMaybeSingle(...args),
        }),
      }),
      update: () => ({
        eq: (...args: unknown[]) => mockUpdateEq(...args),
      }),
    }),
  },
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/i18n', () => {
  const en = {
    joinFailed: 'Failed to join',
    saveFailed: 'Failed to save',
  }
  return {
    setLanguage: jest.fn(),
    translations: {
      en,
      ja: en,
      ko: en,
      zh: en,
    },
  }
})

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf' }),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: jest.fn(),
}))

jest.mock('../load-data', () => ({
  loadOnboardingGroups: (...args: unknown[]) => mockLoadGroups(...args),
  loadOnboardingTraders: (...args: unknown[]) => mockLoadTraders(...args),
}))

jest.mock('../components/WelcomeStep', () => ({
  __esModule: true,
  default: ({ onContinue }: { onContinue: () => void }) => (
    <button onClick={onContinue}>Start onboarding</button>
  ),
}))

jest.mock('../components/InterestsStep', () => ({
  __esModule: true,
  default: ({ onContinue }: { onContinue: () => void }) => (
    <button onClick={onContinue}>Continue to traders</button>
  ),
}))

jest.mock('../components/TradersStep', () => ({
  __esModule: true,
  default: ({ onContinue }: { onContinue: () => void }) => (
    <button onClick={onContinue}>Continue to groups</button>
  ),
}))

jest.mock('../components/GroupsStep', () => ({
  __esModule: true,
  default: ({
    onComplete,
    onJoinGroup,
  }: {
    onComplete: () => void
    onJoinGroup: (groupId: string) => void
  }) => (
    <div>
      <button onClick={() => onJoinGroup(GROUP_ID)}>Join test group</button>
      <button onClick={onComplete}>Complete onboarding</button>
    </div>
  ),
}))

jest.mock('../components/CompleteStep', () => ({
  __esModule: true,
  default: () => <div data-testid="onboarding-complete">Complete</div>,
}))

import OnboardingPage from '../page'

function membershipResponse(status: number, payload: unknown) {
  return {
    json: jest.fn().mockResolvedValue(payload),
    ok: status >= 200 && status < 300,
    status,
  }
}

async function reachGroupsStep() {
  render(<OnboardingPage />)
  await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalled())

  fireEvent.click(screen.getByRole('button', { name: 'Start onboarding' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to traders' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue to groups' }))
  await screen.findByRole('button', { name: 'Join test group' })
}

describe('onboarding membership completion boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'access-token', user: { id: USER_ID } } },
    })
    mockMaybeSingle.mockResolvedValue({
      data: { onboarding_completed: false },
      error: null,
    })
    mockUpdateEq.mockResolvedValue({ error: null })
    mockLoadTraders.mockResolvedValue([])
    mockLoadGroups.mockResolvedValue([])
  })

  it('does not mark onboarding complete when the selected group join is rejected', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(membershipResponse(503, { error: 'temporarily unavailable' }))
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetcher })
    await reachGroupsStep()

    fireEvent.click(screen.getByRole('button', { name: 'Join test group' }))
    fireEvent.click(screen.getByRole('button', { name: 'Complete onboarding' }))

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to join', 'error'))
    expect(mockUpdateEq).not.toHaveBeenCalled()
    expect(screen.queryByTestId('onboarding-complete')).not.toBeInTheDocument()
    expect(localStorage.getItem('hasOnboarded')).toBeNull()
  })

  it('allows an explicit rejoin to recover before completing', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(membershipResponse(503, { error: 'temporarily unavailable' }))
      .mockResolvedValueOnce(
        membershipResponse(200, { success: true, action: 'joined', member_count: 1 })
      )
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetcher })
    await reachGroupsStep()

    fireEvent.click(screen.getByRole('button', { name: 'Join test group' }))
    fireEvent.click(screen.getByRole('button', { name: 'Complete onboarding' }))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Failed to join', 'error'))

    fireEvent.click(screen.getByRole('button', { name: 'Join test group' }))
    fireEvent.click(screen.getByRole('button', { name: 'Complete onboarding' }))

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mockUpdateEq).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('onboarding-complete')).toBeInTheDocument()
    expect(localStorage.getItem('hasOnboarded')).toBe('true')
  })
})

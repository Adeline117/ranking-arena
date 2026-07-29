import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import TopNavClient, {
  GoProButtonFallback,
  TOP_NAV_AUTH_SLOT_WIDTH,
  TOP_NAV_PRO_SLOT_WIDTH,
  TopNavProSlot,
} from '../TopNavClient'
import { criticalCss } from '@/lib/performance/critical-css'

const mockUseTopNavState = jest.fn()
const mockPrefetch = jest.fn()

jest.mock('../useTopNavState', () => ({
  useTopNavState: () => mockUseTopNavState(),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    prefetch: mockPrefetch,
  }),
}))

jest.mock('next/dynamic', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: () =>
      function DynamicStub(props: Record<string, unknown>) {
        if ('myId' in props) {
          return React.createElement(
            'div',
            { 'data-testid': 'user-menu' },
            `${String(props.myId)}|${String(props.myHandle)}|${String(props.myAvatarUrl)}|${String(props.email)}`
          )
        }
        if ('totalUnread' in props) {
          return React.createElement('div', { 'data-testid': 'notification-button' })
        }
        return null
      },
  }
})

jest.mock('../../ui/ThemeToggle', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('../../ui/LanguageToggle', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('../LoginButton', () => ({
  __esModule: true,
  default: () => <div data-testid="login-button" />,
}))

function canonicalState() {
  return {
    authChecked: true,
    authLoggedIn: true,
    authPending: false,
    handleSearch: jest.fn(),
    isReady: false,
    menuRef: createRef<HTMLDivElement>(),
    myAvatarUrl: 'https://img.test/user-b.png',
    myEmail: 'user-b@example.com',
    myHandle: 'user-b',
    myId: 'user-b',
    profileLoading: true,
    searchQuery: '',
    searchRef: createRef<HTMLDivElement>(),
    setSearchQuery: jest.fn(),
    setShowMobileSearch: jest.fn(),
    setShowSearchDropdown: jest.fn(),
    setShowUserMenu: jest.fn(),
    showMobileSearch: false,
    showSearchDropdown: false,
    showUserMenu: false,
    totalUnread: 0,
    viewerScopeKey: 'user:user-b\u00002\u0000user-b',
  }
}

describe('TopNavClient canonical viewer rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUseTopNavState.mockReturnValue(canonicalState())
  })

  it('renders B controls and safe fallbacks even while its profile request never settles', () => {
    const { container } = render(<TopNavClient />)

    expect(screen.getByTestId('top-nav-auth-slot')).toHaveStyle({
      width: `${TOP_NAV_AUTH_SLOT_WIDTH}px`,
    })
    expect(screen.getByTestId('notification-button')).toBeInTheDocument()
    expect(screen.getByTestId('user-menu')).toHaveTextContent(
      'user-b|user-b|https://img.test/user-b.png|user-b@example.com'
    )
    expect(screen.queryByTestId('login-button')).not.toBeInTheDocument()
    expect(container.querySelector('.skeleton')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('user-a')
  })

  it.each([
    {
      name: 'pending',
      state: { authPending: true, myId: null, myHandle: null, myAvatarUrl: null, myEmail: null },
      expected: 'skeleton',
    },
    {
      name: 'anonymous',
      state: {
        authPending: false,
        authLoggedIn: false,
        myId: null,
        myHandle: null,
        myAvatarUrl: null,
        myEmail: null,
      },
      expected: 'login',
    },
    {
      name: 'authenticated',
      state: { authPending: false },
      expected: 'viewer',
    },
  ])('keeps the $name auth state inside the fixed maximum slot', ({ state, expected }) => {
    mockUseTopNavState.mockReturnValue({ ...canonicalState(), ...state })
    render(<TopNavClient />)

    const slot = screen.getByTestId('top-nav-auth-slot')
    expect(slot).toHaveStyle({
      width: `${TOP_NAV_AUTH_SLOT_WIDTH}px`,
      flexShrink: '0',
    })

    if (expected === 'skeleton') {
      expect(slot.querySelector('.skeleton')).toBeInTheDocument()
    } else if (expected === 'login') {
      expect(screen.getByTestId('login-button')).toBeInTheDocument()
    } else {
      expect(screen.getByTestId('notification-button')).toBeInTheDocument()
      expect(screen.getByTestId('user-menu')).toBeInTheDocument()
    }
  })

  it('reserves the exact Go Pro footprint only when the promo is disabled', () => {
    const { rerender } = render(
      <TopNavProSlot promoEnabled>
        <GoProButtonFallback />
      </TopNavProSlot>
    )
    expect(screen.queryByTestId('top-nav-pro-slot')).not.toBeInTheDocument()

    rerender(
      <TopNavProSlot promoEnabled={false}>
        <GoProButtonFallback />
      </TopNavProSlot>
    )

    expect(screen.getByTestId('top-nav-pro-slot')).toHaveStyle({
      width: `${TOP_NAV_PRO_SLOT_WIDTH}px`,
      height: '30px',
      flexShrink: '0',
    })
    expect(screen.getByTestId('top-nav-pro-fallback')).toHaveStyle({
      width: '100%',
      height: '30px',
    })
  })

  it('ships the narrow-nav policy in critical CSS before the main stylesheet arrives', () => {
    expect(criticalCss).toContain(
      '@media(max-width:400px){.top-nav-theme-action{display:none!important}}'
    )
    expect(criticalCss).toContain(
      '@media(max-width:360px){.top-nav-logo-word{display:none!important}}'
    )
  })
})

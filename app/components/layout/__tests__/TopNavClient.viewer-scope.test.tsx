import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import TopNavClient from '../TopNavClient'

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

describe('TopNavClient canonical viewer rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUseTopNavState.mockReturnValue({
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
    })
  })

  it('renders B controls and safe fallbacks even while its profile request never settles', () => {
    const { container } = render(<TopNavClient />)

    expect(screen.getByTestId('notification-button')).toBeInTheDocument()
    expect(screen.getByTestId('user-menu')).toHaveTextContent(
      'user-b|user-b|https://img.test/user-b.png|user-b@example.com'
    )
    expect(screen.queryByTestId('login-button')).not.toBeInTheDocument()
    expect(container.querySelector('.skeleton')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('user-a')
  })
})

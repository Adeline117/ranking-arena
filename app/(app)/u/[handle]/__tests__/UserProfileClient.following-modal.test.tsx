import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ServerProfile } from '../components/types'

let mockProfile: ServerProfile
let mockIsOwnProfile = false
const mockUseUserProfile = jest.fn()

jest.mock('@/lib/features', () => ({ features: { social: true } }))
jest.mock('@/app/components/ui/Breadcrumb', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/app/components/ui/Dynamic', () => ({
  DynamicFollowListModal: ({
    isOpen,
    type,
    isPublic,
  }: {
    isOpen: boolean
    type: 'followers' | 'following'
    isPublic: boolean
  }) =>
    isOpen ? <div role="dialog" data-list-type={type} data-list-public={String(isPublic)} /> : null,
}))
jest.mock('../components/ProfileNotFound', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('../components/TraderLoadingError', () => ({
  TraderLoading: () => null,
  TraderError: () => null,
}))
jest.mock('../components/TraderProfileView', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('../components/UserProfileHeader', () => ({
  __esModule: true,
  default: ({
    onFollowersClick,
    onFollowingClick,
  }: {
    onFollowersClick: () => void
    onFollowingClick: () => void
  }) => (
    <>
      <button type="button" onClick={onFollowingClick}>
        following entry
      </button>
      <button type="button" onClick={onFollowersClick}>
        followers entry
      </button>
    </>
  ),
}))
jest.mock('../components/UserProfileTabs', () => ({
  __esModule: true,
  default: ({
    activeTab,
    availableTabs,
  }: {
    activeTab: string
    availableTabs: readonly string[]
  }) => (
    <div role="tablist">
      {availableTabs.map((tab) => (
        <button key={tab} id={`uprofile-tab-${tab}`} role="tab" aria-selected={activeTab === tab}>
          {tab}
        </button>
      ))}
    </div>
  ),
}))
jest.mock('../components/UserProfileContent', () => ({
  __esModule: true,
  default: ({ activeTab }: { activeTab: string }) => (
    <div data-testid="profile-content" data-active-tab={activeTab} />
  ),
}))
jest.mock('../hooks/useUserProfile', () => ({
  useUserProfile: (...args: unknown[]) => mockUseUserProfile(...args),
}))

import UserProfileClient from '../UserProfileClient'

function profile(
  showFollowing: boolean | undefined,
  showFollowers: boolean | undefined
): ServerProfile {
  return {
    id: 'target-user',
    handle: 'alice',
    show_followers: showFollowers,
    show_following: showFollowing,
    followers: 3,
    following: 7,
    followingTraders: 0,
    isRegistered: true,
    proBadgeTier: null,
  }
}

function useProfileFixture() {
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null)
  const [followersCount, setFollowersCount] = useState(mockProfile.followers)

  return {
    email: null,
    currentUserId: mockIsOwnProfile ? mockProfile.id : 'viewer-user',
    profile: mockProfile,
    isPro: false,
    isOwnProfile: mockIsOwnProfile,
    t: (key: string) => key,
    modalType,
    setModalType,
    followersCount,
    setFollowersCount,
    followingCount: mockProfile.following,
    activeProfileTab: 'overview' as const,
    availableProfileTabs: ['overview'] as const,
    handleProfileTabChange: jest.fn(),
    isTrader: false,
    traderData: null,
    isTraderDataLoading: false,
    isTraderDataError: false,
    isBlocked: false,
  }
}

describe('UserProfileClient following modal privacy', () => {
  beforeEach(() => {
    mockProfile = profile(true, true)
    mockIsOwnProfile = false
    mockUseUserProfile.mockImplementation(useProfileFixture)
  })

  it('wires another user public following entry to the following modal', () => {
    render(<UserProfileClient handle="alice" serverProfile={mockProfile} />)

    fireEvent.click(screen.getByRole('button', { name: 'following entry' }))

    expect(screen.getByRole('dialog')).toHaveAttribute('data-list-type', 'following')
    expect(screen.getByRole('dialog')).toHaveAttribute('data-list-public', 'true')
  })

  it.each([false, undefined])(
    'refuses to mount another user non-public following modal (%s)',
    (showFollowing) => {
      mockProfile = profile(showFollowing, true)
      render(<UserProfileClient handle="alice" serverProfile={mockProfile} />)

      fireEvent.click(screen.getByRole('button', { name: 'following entry' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
  )

  it('wires another user public followers entry to the followers modal', () => {
    render(<UserProfileClient handle="alice" serverProfile={mockProfile} />)

    fireEvent.click(screen.getByRole('button', { name: 'followers entry' }))

    expect(screen.getByRole('dialog')).toHaveAttribute('data-list-type', 'followers')
    expect(screen.getByRole('dialog')).toHaveAttribute('data-list-public', 'true')
  })

  it.each([false, undefined])(
    'refuses to mount another user non-public followers modal (%s)',
    (showFollowers) => {
      mockProfile = profile(true, showFollowers)
      render(<UserProfileClient handle="alice" serverProfile={mockProfile} />)

      fireEvent.click(screen.getByRole('button', { name: 'followers entry' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
  )

  it.each([true, false, undefined])(
    'leaves the owner following action to the full-page route instead of a modal (%s)',
    (showFollowing) => {
      mockProfile = profile(showFollowing, true)
      mockIsOwnProfile = true
      render(<UserProfileClient handle="alice" serverProfile={mockProfile} />)

      fireEvent.click(screen.getByRole('button', { name: 'following entry' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
  )

  it('uses the same canonical tab key for the visible tab, panel label, and content', () => {
    render(<UserProfileClient handle="alice" serverProfile={mockProfile} />)

    expect(screen.getByRole('tab', { name: 'overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'uprofile-tab-overview')
    expect(screen.getByTestId('profile-content')).toHaveAttribute('data-active-tab', 'overview')
  })
})

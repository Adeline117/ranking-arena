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
  default: ({ onFollowingClick }: { onFollowingClick: () => void }) => (
    <button type="button" onClick={onFollowingClick}>
      following entry
    </button>
  ),
}))
jest.mock('../components/UserProfileTabs', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('../components/UserProfileContent', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('../hooks/useUserProfile', () => ({
  useUserProfile: (...args: unknown[]) => mockUseUserProfile(...args),
}))

import UserProfileClient from '../UserProfileClient'

function profile(showFollowing: boolean | undefined): ServerProfile {
  return {
    id: 'target-user',
    handle: 'alice',
    show_followers: true,
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
    mockProfile = profile(true)
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
      mockProfile = profile(showFollowing)
      render(<UserProfileClient handle="alice" serverProfile={mockProfile} />)

      fireEvent.click(screen.getByRole('button', { name: 'following entry' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
  )

  it.each([true, false, undefined])(
    'leaves the owner following action to the full-page route instead of a modal (%s)',
    (showFollowing) => {
      mockProfile = profile(showFollowing)
      mockIsOwnProfile = true
      render(<UserProfileClient handle="alice" serverProfile={mockProfile} />)

      fireEvent.click(screen.getByRole('button', { name: 'following entry' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
  )
})

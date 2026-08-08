import { fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServerProfile } from '../types'

const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/lib/features', () => ({ features: { social: true } }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/ui/ProBadge', () => ({
  __esModule: true,
  default: () => null,
  ProBadgeOverlay: () => null,
}))
jest.mock('@/app/components/user/LevelBadge', () => ({
  __esModule: true,
  default: () => null,
}))

import UserProfileHeader from '../UserProfileHeader'

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

function renderHeader({
  showFollowing,
  isOwnProfile = false,
}: {
  showFollowing: boolean | undefined
  isOwnProfile?: boolean
}) {
  const onFollowingClick = jest.fn()

  const view = render(
    <UserProfileHeader
      profile={profile(showFollowing)}
      handle="alice"
      isOwnProfile={isOwnProfile}
      currentUserId={isOwnProfile ? 'target-user' : 'viewer-user'}
      followersCount={3}
      followingCount={7}
      onFollowersCountChange={jest.fn()}
      onFollowingClick={onFollowingClick}
      onFollowersClick={jest.fn()}
    />
  )

  return {
    container: view.container,
    onFollowingClick,
    followingButton: screen.getByRole('button', { name: '7 following' }),
  }
}

describe('UserProfileHeader following privacy', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  it('opens a registered public profile following list', () => {
    const { followingButton, onFollowingClick } = renderHeader({ showFollowing: true })

    expect(followingButton).toBeEnabled()
    fireEvent.click(followingButton)

    expect(onFollowingClick).toHaveBeenCalledTimes(1)
  })

  it('keeps server-rendered profile identity visible before hydration', () => {
    const markup = renderToStaticMarkup(
      <UserProfileHeader
        profile={profile(true)}
        handle="alice"
        isOwnProfile={false}
        currentUserId={null}
        followersCount={3}
        followingCount={7}
        onFollowersCountChange={jest.fn()}
        onFollowingClick={jest.fn()}
        onFollowersClick={jest.fn()}
      />
    )

    expect(markup).toContain('profile-header')
    expect(markup).toContain('alice')
    expect(markup).not.toMatch(/opacity:\s*0/)
  })

  it('does not present the static avatar as an action', () => {
    const { container } = renderHeader({ showFollowing: true })
    const avatar = container.querySelector('.profile-header-avatar')

    expect(avatar).not.toHaveAttribute('role', 'button')
    expect(avatar).not.toHaveAttribute('tabindex')
    expect(avatar).not.toHaveStyle({ cursor: 'pointer' })
  })

  it.each([false, undefined])(
    'does not expose another user non-public following entry (%s)',
    (showFollowing) => {
      const { followingButton, onFollowingClick } = renderHeader({ showFollowing })

      expect(followingButton).toBeDisabled()
      fireEvent.click(followingButton)

      expect(onFollowingClick).not.toHaveBeenCalled()
      expect(mockPush).not.toHaveBeenCalled()
    }
  )

  it.each([false, undefined])(
    'routes the owner non-public following entry to the full management page (%s)',
    (showFollowing) => {
      const { followingButton, onFollowingClick } = renderHeader({
        showFollowing,
        isOwnProfile: true,
      })

      expect(followingButton).toBeEnabled()
      fireEvent.click(followingButton)

      expect(mockPush).toHaveBeenCalledWith('/following')
      expect(onFollowingClick).not.toHaveBeenCalled()
    }
  )
})

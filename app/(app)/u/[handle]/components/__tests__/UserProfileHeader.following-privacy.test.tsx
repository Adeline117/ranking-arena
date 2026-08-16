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
  default: ({ contrastSurface }: { contrastSurface?: boolean }) => (
    <span data-testid="level-badge" data-contrast-surface={String(Boolean(contrastSurface))} />
  ),
}))
jest.mock('@/app/components/common/ShareButton', () => ({
  __esModule: true,
  default: ({
    data,
    showLabel,
  }: {
    data: { type: string; url: string; userHandle?: string }
    showLabel?: boolean
  }) => (
    <button
      type="button"
      aria-label="share profile"
      data-share-type={data.type}
      data-share-url={data.url}
      data-share-handle={data.userHandle}
      data-show-label={String(showLabel)}
    />
  ),
}))

import UserProfileHeader from '../UserProfileHeader'

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

function renderHeader({
  showFollowing,
  showFollowers,
  isOwnProfile = false,
}: {
  showFollowing: boolean | undefined
  showFollowers: boolean | undefined
  isOwnProfile?: boolean
}) {
  const onFollowingClick = jest.fn()
  const onFollowersClick = jest.fn()

  const view = render(
    <UserProfileHeader
      profile={profile(showFollowing, showFollowers)}
      handle="alice"
      isOwnProfile={isOwnProfile}
      currentUserId={isOwnProfile ? 'target-user' : 'viewer-user'}
      followersCount={3}
      followingCount={7}
      onFollowersCountChange={jest.fn()}
      onFollowingClick={onFollowingClick}
      onFollowersClick={onFollowersClick}
    />
  )

  return {
    container: view.container,
    followersButton: screen.getByRole('button', { name: '3 followers' }),
    onFollowersClick,
    onFollowingClick,
    followingButton: screen.getByRole('button', { name: '7 following' }),
  }
}

describe('UserProfileHeader following privacy', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  it('opens a registered public profile following list', () => {
    const { followingButton, onFollowingClick } = renderHeader({
      showFollowing: true,
      showFollowers: true,
    })

    expect(followingButton).toBeEnabled()
    fireEvent.click(followingButton)

    expect(onFollowingClick).toHaveBeenCalledTimes(1)
  })

  it('keeps server-rendered profile identity visible before hydration', () => {
    const markup = renderToStaticMarkup(
      <UserProfileHeader
        profile={profile(true, true)}
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
    const { container } = renderHeader({ showFollowing: true, showFollowers: true })
    const avatar = container.querySelector('.profile-header-avatar')

    expect(avatar).not.toHaveAttribute('role', 'button')
    expect(avatar).not.toHaveAttribute('tabindex')
    expect(avatar).not.toHaveStyle({ cursor: 'pointer' })
  })

  it('uses a page heading and valid inline content inside social buttons', () => {
    const { followersButton, followingButton } = renderHeader({
      showFollowing: true,
      showFollowers: true,
    })

    expect(screen.getByRole('heading', { level: 1, name: 'alice' })).toBeInTheDocument()
    expect(followingButton.querySelector('p')).toBeNull()
    expect(followersButton.querySelector('p')).toBeNull()
    expect(followingButton.querySelector('span')).not.toBeNull()
    expect(followersButton.querySelector('span')).not.toBeNull()
  })

  it('offers the canonical encoded profile URL to the share action', () => {
    render(
      <UserProfileHeader
        profile={{ ...profile(true, true), handle: '爱丽丝 user' }}
        handle="爱丽丝 user"
        isOwnProfile={false}
        currentUserId={null}
        followersCount={3}
        followingCount={7}
        onFollowersCountChange={jest.fn()}
        onFollowingClick={jest.fn()}
        onFollowersClick={jest.fn()}
      />
    )

    const share = screen.getByRole('button', { name: 'share profile' })
    expect(share).toHaveAttribute('data-share-type', 'user')
    expect(share).toHaveAttribute('data-share-handle', '爱丽丝 user')
    expect(share).toHaveAttribute('data-show-label', 'false')
    expect(share.getAttribute('data-share-url')).toMatch(/\/u\/%E7%88%B1%E4%B8%BD%E4%B8%9D%20user$/)
    expect(share.closest('.profile-header-actions')).toHaveStyle({ flexWrap: 'wrap' })
  })

  it('uses opaque cover text and the contrast badge surface', () => {
    render(
      <UserProfileHeader
        profile={{
          ...profile(true, true),
          bio: 'Readable biography',
          cover_url: 'https://cdn.example.com/cover.jpg',
        }}
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

    expect(screen.getByText('Readable biography')).toHaveStyle({ color: '#FFFFFF' })
    expect(screen.getByTestId('level-badge')).toHaveAttribute('data-contrast-surface', 'true')
  })

  it.each([false, undefined])(
    'does not expose another user non-public following entry (%s)',
    (showFollowing) => {
      const { followingButton, onFollowingClick } = renderHeader({
        showFollowing,
        showFollowers: true,
      })

      expect(followingButton).toBeDisabled()
      fireEvent.click(followingButton)

      expect(onFollowingClick).not.toHaveBeenCalled()
      expect(mockPush).not.toHaveBeenCalled()
    }
  )

  it.each([false, undefined])(
    'does not expose another user non-public followers entry (%s)',
    (showFollowers) => {
      const { followersButton, onFollowersClick } = renderHeader({
        showFollowing: true,
        showFollowers,
      })

      expect(followersButton).toBeDisabled()
      fireEvent.click(followersButton)

      expect(onFollowersClick).not.toHaveBeenCalled()
    }
  )

  it.each([false, undefined])(
    'opens the owner following list without routing to the mixed management page (%s)',
    (showFollowing) => {
      const { followingButton, onFollowingClick } = renderHeader({
        showFollowing,
        showFollowers: true,
        isOwnProfile: true,
      })

      expect(followingButton).toBeEnabled()
      fireEvent.click(followingButton)

      expect(onFollowingClick).toHaveBeenCalledTimes(1)
      expect(mockPush).not.toHaveBeenCalled()
    }
  )
})

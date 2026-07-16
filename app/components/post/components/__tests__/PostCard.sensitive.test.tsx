import { render, screen } from '@testing-library/react'
import type { PostWithUserState } from '@/lib/types'
import { PostCard } from '../PostCard'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

jest.mock('../PostActions', () => ({ ReactButton: () => null }))
jest.mock('../AvatarLink', () => ({
  AvatarLink: ({ handle }: { handle: string }) => <span>{handle}</span>,
}))
jest.mock('@/app/components/user/LevelBadge', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('@/lib/tracking', () => ({ sendTrackingEvent: jest.fn() }))
jest.mock('@/lib/utils/date', () => ({ formatTimeAgo: () => 'now' }))

const post = (overrides: Partial<PostWithUserState> = {}): PostWithUserState =>
  ({
    id: 'post-1',
    title: 'private root title',
    content: 'private root content',
    author_id: 'author-1',
    author_handle: 'author',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    visibility: 'public',
    poll_enabled: false,
    like_count: 0,
    dislike_count: 0,
    comment_count: 0,
    bookmark_count: 0,
    repost_count: 0,
    view_count: 0,
    is_pinned: false,
    is_sensitive: false,
    ...overrides,
  }) as PostWithUserState

describe('PostCard compact sensitive content', () => {
  beforeAll(() => {
    class MockIntersectionObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
  })

  it.each([{ is_sensitive: true }, { content_warning: 'root content warning' }])(
    'redacts the title without changing compact card structure',
    (sensitiveFields) => {
      const { container } = render(<PostCard post={post(sensitiveFields)} variant="compact" />)

      expect(screen.getByText('sensitiveContent')).toBeInTheDocument()
      expect(screen.queryByText('private root title')).not.toBeInTheDocument()
      expect(container.firstElementChild).toHaveClass('list-item-hover')
      expect(container.firstElementChild?.children).toHaveLength(2)
    }
  )

  it('keeps the ordinary compact title unchanged', () => {
    render(<PostCard post={post({ title: 'public title' })} variant="compact" />)

    expect(screen.getByText('public title')).toBeInTheDocument()
    expect(screen.queryByText('sensitiveContent')).not.toBeInTheDocument()
  })
})

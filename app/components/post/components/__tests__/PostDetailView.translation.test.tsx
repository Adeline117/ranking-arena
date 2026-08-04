import { fireEvent, render, screen } from '@testing-library/react'
import PostDetailView from '../PostDetailView'

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt} />,
}))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('@/app/components/user/LevelBadge', () => () => null)
jest.mock('@/app/components/ui/Dynamic', () => ({
  DynamicCommentsModal: () => <div data-testid="comments" />,
}))
jest.mock('../index', () => ({
  AvatarLink: () => null,
  PostModal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CustomPollCard: () => null,
  BuiltInVoteCard: ({
    postId,
    onVote,
  }: {
    postId: string
    onVote: (postId: string, choice: 'bull') => void
  }) => <button onClick={() => onVote(postId, 'bull')}>built-in-vote</button>,
  PostDetailActions: () => null,
}))

const post = {
  id: 'post-1',
  title: '原始标题',
  content: '原始正文',
  author_id: 'author-1',
  author_handle: 'author',
  author_avatar_url: null,
  author_is_pro: false,
  author_show_pro_badge: false,
  author_exp: 0,
  created_at: '2026-08-03T00:00:00.000Z',
  comment_count: 0,
  like_count: 0,
  dislike_count: 0,
  user_reaction: null,
  user_vote: null,
  poll_enabled: false,
  poll_bull: 0,
  poll_bear: 0,
  poll_wait: 0,
  group_name: null,
  group_id: null,
  poll_id: null,
  original_post: null,
}

function renderView(overrides: Partial<React.ComponentProps<typeof PostDetailView>> = {}) {
  const setShowingOriginal = jest.fn()
  const props: React.ComponentProps<typeof PostDetailView> = {
    openPost: post as never,
    onClose: jest.fn(),
    asPage: true,
    language: 'en',
    currentUserId: 'user-a',
    viewerKey: 'user:user-a',
    accessToken: 'token-a',
    showingOriginal: true,
    setShowingOriginal,
    translatedContent: 'Translated body',
    translating: false,
    contentTranslationResolved: true,
    translatedTitle: 'Translated title',
    translatingTitle: false,
    titleTranslationResolved: true,
    translatingComments: false,
    translatingCommentLanes: {},
    translatedListPosts: { 'post-1': { title: 'Translated title' } },
    removeImagesFromContent: (value) => value,
    customPoll: null,
    customPollLoadState: 'idle',
    customPollUserVotes: [],
    selectedPollOptions: [],
    setSelectedPollOptions: jest.fn(),
    votingCustomPoll: false,
    loadCustomPoll: jest.fn().mockResolvedValue(undefined),
    submitCustomPollVote: jest.fn().mockResolvedValue(undefined),
    onToggleBuiltInVote: jest.fn().mockResolvedValue(undefined),
    userReaction: null,
    userBookmarks: {},
    bookmarkCounts: {},
    onToggleReaction: jest.fn().mockResolvedValue(undefined),
    onBookmark: jest.fn().mockResolvedValue(undefined),
    onOpenBookmarkFolder: jest.fn(),
    onRepost: jest.fn(),
    showToast: jest.fn(),
    comments: [],
    loadingComments: false,
    submittingComment: false,
    onSubmitComment: jest.fn().mockResolvedValue(true),
    replyingTo: null,
    setReplyingTo: jest.fn(),
    submittingReply: false,
    onSubmitReply: jest.fn().mockResolvedValue(true),
    commentLikeLoading: {},
    onToggleCommentLike: jest.fn().mockResolvedValue(undefined),
    onToggleCommentDislike: jest.fn().mockResolvedValue(undefined),
    deletingCommentId: null,
    onDeleteComment: jest.fn().mockResolvedValue(undefined),
    editingComment: null,
    submittingEdit: false,
    onStartEdit: jest.fn(),
    onCancelEdit: jest.fn(),
    onSubmitEdit: jest.fn().mockResolvedValue(true),
    expandedReplies: {},
    setExpandedReplies: jest.fn(),
    translatedComments: {},
    t: (key) => key,
    ...overrides,
  }
  return { ...render(<PostDetailView {...props} />), setShowingOriginal }
}

describe('PostDetailView translation controls', () => {
  it('exposes a 44px control and toggles between original and translated truth', () => {
    const { unmount, setShowingOriginal } = renderView()
    const button = screen.getByRole('button', { name: 'viewTranslation' })

    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(button).toHaveStyle({ minWidth: '44px', minHeight: '44px' })
    fireEvent.click(button)
    expect(setShowingOriginal).toHaveBeenCalledWith(false)

    unmount()
    renderView({ showingOriginal: false })
    expect(screen.getByText('Translated body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'viewOriginal' })).toBeInTheDocument()
  })

  it('announces content/title and comment lanes while preventing an early toggle', () => {
    renderView({
      translatedContent: null,
      translating: true,
      contentTranslationResolved: false,
      translatedTitle: null,
      translatingTitle: true,
      titleTranslationResolved: false,
      translatingComments: true,
      translatingCommentLanes: { 'comment-1': true, 'comment-2': true },
    })

    const button = screen.getByRole('button', { name: 'translating' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('comments').parentElement).toHaveAttribute('aria-busy', 'true')
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  it('publishes title and body atomically and keeps the source after a partial failure', () => {
    const pending = renderView({
      showingOriginal: false,
      translatedContent: 'Translated body',
      translating: false,
      contentTranslationResolved: true,
      translatedTitle: null,
      translatingTitle: true,
      titleTranslationResolved: false,
    })

    expect(screen.getByText('原始标题')).toBeInTheDocument()
    expect(screen.getByText('原始正文')).toBeInTheDocument()
    expect(screen.queryByText('Translated body')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'translating' })).toBeDisabled()

    pending.unmount()
    const complete = renderView({ showingOriginal: false })
    expect(screen.getByText('Translated title')).toBeInTheDocument()
    expect(screen.getByText('Translated body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'viewOriginal' })).toBeInTheDocument()

    complete.unmount()
    renderView({
      showingOriginal: false,
      translatedContent: 'Translated body',
      translating: false,
      contentTranslationResolved: true,
      translatedTitle: null,
      translatingTitle: false,
      titleTranslationResolved: false,
    })
    expect(screen.getByText('原始标题')).toBeInTheDocument()
    expect(screen.getByText('原始正文')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'viewOriginal' })).not.toBeInTheDocument()
  })

  it('treats a same-language title receipt as resolved beside a translated body', () => {
    renderView({
      openPost: { ...post, content: 'English market update' } as never,
      language: 'zh',
      showingOriginal: false,
      translatedContent: '中文市场更新',
      contentTranslationResolved: true,
      translatedTitle: null,
      translatingTitle: false,
      titleTranslationResolved: true,
    })

    expect(screen.getByText('原始标题')).toBeInTheDocument()
    expect(screen.getByText('中文市场更新')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'viewOriginal' })).toBeInTheDocument()
  })

  it('renders and wires a legacy built-in poll only when no custom poll owns the post', () => {
    const onToggleBuiltInVote = jest.fn().mockResolvedValue(undefined)
    renderView({
      openPost: { ...post, poll_enabled: true } as never,
      onToggleBuiltInVote,
    })

    fireEvent.click(screen.getByRole('button', { name: 'built-in-vote' }))
    expect(onToggleBuiltInVote).toHaveBeenCalledWith('post-1', 'bull')
  })
})

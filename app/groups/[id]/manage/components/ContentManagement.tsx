'use client'

import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'

type Post = {
  id: string
  title: string
  content?: string | null
  author_handle?: string | null
  created_at: string
  deleted_at?: string | null
  is_pinned?: boolean | null
}

type Comment = {
  id: string
  content: string
  author_handle?: string | null
  created_at: string
  deleted_at?: string | null
  post_id: string
}

interface ContentManagementProps {
  posts: Post[]
  comments: Comment[]
  filteredPosts: Post[]
  filteredComments: Comment[]
  contentSearch: string
  setContentSearch: (v: string) => void
  hasMorePosts: boolean
  loadingMorePosts: boolean
  pinningPost: string | null
  onDeletePost: (postId: string) => void
  onDeleteComment: (commentId: string) => void
  onPinPost: (postId: string) => void
  onLoadMorePosts: () => void
  language: string
  inputStyle: React.CSSProperties
  t: (key: string) => string
}

export default function ContentManagement({
  posts,
  comments,
  filteredPosts,
  filteredComments,
  contentSearch,
  setContentSearch,
  hasMorePosts,
  loadingMorePosts,
  pinningPost,
  onDeletePost,
  onDeleteComment,
  onPinPost,
  onLoadMorePosts,
  language,
  inputStyle,
  t,
}: ContentManagementProps) {
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
      {/* 搜索栏 */}
      <Box style={{ position: 'relative' }}>
        <input
          type="text"
          value={contentSearch}
          onChange={(e) => setContentSearch(e.target.value)}
          placeholder={t('searchPostsCommentsAuthors')}
          style={{ ...inputStyle, paddingLeft: tokens.spacing[10] }}
        />
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2"
          style={{ position: 'absolute', left: tokens.spacing[4], top: '50%', transform: 'translateY(-50%)' }}>
          <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
        </svg>
        {contentSearch && (
          <button aria-label="Close" onClick={() => setContentSearch('')}
            style={{ position: 'absolute', right: tokens.spacing[4], top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.lg, lineHeight: 1.2, padding: tokens.spacing[1] }}>
            ×
          </button>
        )}
      </Box>

      {/* 帖子 */}
      <Card title={`${t('posts')} (${filteredPosts.length}${contentSearch ? `/${posts.length}` : ''})`}>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {filteredPosts.map((post) => (
            <Box key={post.id} style={{
              padding: tokens.spacing[3],
              background: post.deleted_at ? 'var(--color-accent-error-10)' : post.is_pinned ? `linear-gradient(135deg, ${tokens.colors.accent?.primary || tokens.colors.accent.brand}15 0%, ${tokens.colors.bg.secondary} 100%)` : tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${post.deleted_at ? 'var(--color-accent-error-20)' : post.is_pinned ? `${tokens.colors.accent?.primary || tokens.colors.accent.brand}50` : tokens.colors.border.primary}`,
            }}>
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                    {post.is_pinned && (
                      <span style={{ fontSize: tokens.typography.fontSize.xs, padding: `2px ${tokens.spacing[2]}`, borderRadius: tokens.radius.full, background: `${tokens.colors.accent?.primary || tokens.colors.accent.brand}20`, color: tokens.colors.accent?.primary || tokens.colors.accent.brand, fontWeight: tokens.typography.fontWeight.bold, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        PIN {t('pinnedLabel')}
                      </span>
                    )}
                    <Text weight="bold" style={{ textDecoration: post.deleted_at ? 'line-through' : 'none' }}>{post.title}</Text>
                  </Box>
                  <Text size="xs" color="tertiary">@{post.author_handle} · {new Date(post.created_at).toLocaleString(getLocaleFromLanguage(language))}</Text>
                  {post.deleted_at && <Text size="xs" style={{ color: 'var(--color-accent-error)', marginTop: 4 }}>{t('deletedByAdmin')}</Text>}
                </Box>
                {!post.deleted_at && (
                  <Box style={{ display: 'flex', gap: tokens.spacing[2], flexShrink: 0 }}>
                    <Button variant="secondary" size="sm" onClick={() => onPinPost(post.id)} disabled={pinningPost === post.id}
                      style={{ color: post.is_pinned ? tokens.colors.accent?.primary || tokens.colors.accent.brand : tokens.colors.text.secondary }}>
                      {pinningPost === post.id ? '...' : post.is_pinned ? t('unpin') : t('pin')}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => onDeletePost(post.id)} style={{ color: 'var(--color-accent-error)' }}>{t('delete')}</Button>
                  </Box>
                )}
              </Box>
            </Box>
          ))}
          {filteredPosts.length === 0 && (
            <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>{contentSearch ? t('noMatchingPosts') : t('noPostsYet')}</Text>
          )}
          {hasMorePosts && !contentSearch && (
            <Box style={{ textAlign: 'center', marginTop: tokens.spacing[3] }}>
              <Button variant="secondary" onClick={onLoadMorePosts} disabled={loadingMorePosts}>{loadingMorePosts ? t('loading') : t('loadMore')}</Button>
            </Box>
          )}
        </Box>
      </Card>

      {/* 评论 */}
      <Card title={`${t('comments')} (${filteredComments.length}${contentSearch ? `/${comments.length}` : ''})`}>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {filteredComments.slice(0, 50).map((comment) => (
            <Box key={comment.id} style={{
              padding: tokens.spacing[3],
              background: comment.deleted_at ? 'var(--color-accent-error-10)' : tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${comment.deleted_at ? 'var(--color-accent-error-20)' : tokens.colors.border.primary}`,
            }}>
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Box>
                  <Text size="sm" style={{ textDecoration: comment.deleted_at ? 'line-through' : 'none' }}>
                    {comment.content.slice(0, 100)}{comment.content.length > 100 ? '...' : ''}
                  </Text>
                  <Text size="xs" color="tertiary">@{comment.author_handle} · {new Date(comment.created_at).toLocaleString(getLocaleFromLanguage(language))}</Text>
                  {comment.deleted_at && <Text size="xs" style={{ color: 'var(--color-accent-error)', marginTop: 4 }}>{t('deletedByAdmin')}</Text>}
                </Box>
                {!comment.deleted_at && (
                  <Button variant="secondary" size="sm" onClick={() => onDeleteComment(comment.id)} style={{ color: 'var(--color-accent-error)' }}>{t('delete')}</Button>
                )}
              </Box>
            </Box>
          ))}
          {filteredComments.length === 0 && (
            <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>{contentSearch ? t('noMatchingComments') : t('noCommentsYet')}</Text>
          )}
        </Box>
      </Card>
    </Box>
  )
}

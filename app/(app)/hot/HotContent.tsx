'use client'

import { Suspense, lazy } from 'react'
import { tokens } from '@/lib/design-tokens'
import ThreeColumnLayout from '@/app/components/layout/ThreeColumnLayout'
const TopTraders = lazy(() => import('@/app/components/sidebar/TopTraders'))
const WatchlistMarket = lazy(() => import('@/app/components/sidebar/WatchlistMarket'))
const NewsFlash = lazy(() => import('@/app/components/sidebar/NewsFlash'))
import Card from '@/app/components/ui/Card'
import { Box, Text } from '@/app/components/base'
const FloatingActionButton = lazy(() => import('@/app/components/layout/FloatingActionButton'))
import PullToRefreshWrapper from '@/app/components/ui/PullToRefreshWrapper'
import { PostCard } from './components/PostCard'
const PostDetailModal = lazy(() =>
  import('./components/PostDetailModal').then((m) => ({ default: m.PostDetailModal }))
)
const HotGroupsList = lazy(() =>
  import('./components/HotGroupsList').then((m) => ({ default: m.HotGroupsList }))
)
import { useHotPageData } from './useHotPageData'
import type { Post } from './types'
import { useTabsA11y } from '@/lib/hooks/useTabsA11y'

interface HotContentProps {
  initialPosts?: Post[]
}

export default function HotContent({ initialPosts }: HotContentProps) {
  const {
    t,
    language: _language,
    localizedName,
    email,
    loggedIn,
    accessToken,
    loadingPosts,
    postsError,
    refreshPosts,
    visibleHot,
    expandedPosts,
    setExpandedPosts,
    translatedListPosts,
    getHotTag,
    handleOpenPost,
    activeHotTab,
    setActiveHotTab,
    groups,
    loadingGroups,
    openPost,
    comments,
    loadingComments,
    hasMoreComments,
    loadingMoreComments,
    newComment,
    setNewComment,
    submittingComment,
    translatedContent,
    showingOriginal,
    setShowingOriginal,
    translating,
    handleClosePost,
    submitComment,
    toggleReaction,
    loadMoreComments,
  } = useHotPageData({ initialPosts })

  // B2 tabs a11y: posts/groups share the single content region inside the card.
  const hotTabsA11y = useTabsA11y({
    tabs: ['posts', 'groups'] as const,
    active: activeHotTab,
    onChange: setActiveHotTab,
    idPrefix: 'hot',
    sharedPanelId: 'hot-panel',
  })

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      <PullToRefreshWrapper onRefresh={refreshPosts}>
        <Box as="main" py={6} style={{ maxWidth: 1400, margin: '0 auto' }}>
          <ThreeColumnLayout
            leftSidebar={
              <Suspense
                fallback={
                  <div
                    className="skeleton"
                    style={{ height: 300, borderRadius: tokens.radius.lg }}
                  />
                }
              >
                <TopTraders />
              </Suspense>
            }
            rightSidebar={
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  height: 'calc(100vh - 72px)',
                }}
              >
                <div style={{ flexShrink: 0, maxHeight: '35%', overflow: 'auto' }}>
                  <Suspense
                    fallback={
                      <div
                        className="skeleton"
                        style={{ height: 200, borderRadius: tokens.radius.lg }}
                      />
                    }
                  >
                    <WatchlistMarket />
                  </Suspense>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                  <Suspense
                    fallback={
                      <div
                        className="skeleton"
                        style={{ height: 300, borderRadius: tokens.radius.lg }}
                      />
                    }
                  >
                    <NewsFlash />
                  </Suspense>
                </div>
              </div>
            }
          >
            <Box as="section" style={{ minWidth: 0 }}>
              <Card title={t('hotList')}>
                {!loggedIn && (
                  <Text
                    size="xs"
                    color="tertiary"
                    style={{ marginBottom: tokens.spacing[2], fontSize: '11px' }}
                  >
                    {t('loginToLikeCommentPost')}
                  </Text>
                )}

                {/* Tabbed Sections */}
                <Box
                  {...hotTabsA11y.getTabListProps()}
                  aria-label={t('hotList')}
                  style={{
                    display: 'flex',
                    gap: '8px',
                    marginBottom: tokens.spacing[3],
                    flexWrap: 'wrap',
                  }}
                >
                  {[
                    { value: 'posts' as const, label: t('hotPosts') },
                    { value: 'groups' as const, label: t('hotGroups') },
                  ].map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      {...hotTabsA11y.getTabProps(tab.value)}
                      onClick={() => setActiveHotTab(tab.value)}
                      style={{
                        padding: '7px 16px',
                        minHeight: 32,
                        borderRadius: tokens.radius.lg,
                        border: activeHotTab === tab.value ? 'none' : tokens.glass.border.light,
                        background:
                          activeHotTab === tab.value
                            ? tokens.gradient.primary
                            : tokens.glass.bg.light,
                        backdropFilter: tokens.glass.blur.sm,
                        WebkitBackdropFilter: tokens.glass.blur.sm,
                        color:
                          activeHotTab === tab.value
                            ? 'var(--color-on-accent)'
                            : 'var(--color-text-secondary)',
                        fontWeight: activeHotTab === tab.value ? 900 : 600,
                        fontSize: tokens.typography.fontSize.sm,
                        cursor: 'pointer',
                        transition: tokens.transition.all,
                        boxShadow:
                          activeHotTab === tab.value
                            ? `0 4px 12px var(--color-accent-primary-40)`
                            : 'none',
                      }}
                      onMouseEnter={(e) => {
                        if (activeHotTab !== tab.value) {
                          e.currentTarget.style.background = tokens.glass.bg.medium
                          e.currentTarget.style.color = 'var(--color-text-primary)'
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (activeHotTab !== tab.value) {
                          e.currentTarget.style.background = tokens.glass.bg.light
                          e.currentTarget.style.color = 'var(--color-text-secondary)'
                        }
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </Box>

                {/* Tab panel (B2 a11y): wraps both tab-content branches */}
                <div {...hotTabsA11y.getSharedPanelProps()}>
                  {/* Tab Content: Hot Posts */}
                  {activeHotTab === 'posts' && (
                    <>
                      {postsError && (
                        <Box
                          role="alert"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: tokens.spacing[3],
                            padding: tokens.spacing[3],
                            marginBottom: tokens.spacing[3],
                            borderRadius: tokens.radius.lg,
                            background: 'var(--color-accent-error-10)',
                            border: '1px solid var(--color-red-border)',
                          }}
                        >
                          <Text size="sm" style={{ color: tokens.colors.accent.error }}>
                            {t('loadHotPostsFailed')}
                          </Text>
                          <button
                            type="button"
                            onClick={() => void refreshPosts()}
                            style={{
                              flexShrink: 0,
                              border: 0,
                              background: 'none',
                              color: tokens.colors.accent.primary,
                              font: 'inherit',
                              fontWeight: Number(tokens.typography.fontWeight.bold),
                              cursor: 'pointer',
                            }}
                          >
                            {t('retry')}
                          </button>
                        </Box>
                      )}
                      {loadingPosts ? (
                        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                          <Text color="tertiary">{t('loading')}</Text>
                        </Box>
                      ) : visibleHot.length === 0 ? (
                        !postsError && (
                          <div className="empty-state" style={{ padding: '64px 24px' }}>
                            <div className="empty-state-icon">
                              <svg
                                width="28"
                                height="28"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                              >
                                <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                              </svg>
                            </div>
                            <p className="empty-state-title">{t('noData')}</p>
                          </div>
                        )
                      ) : (
                        <Box
                          className="stagger-fade"
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: tokens.spacing[2],
                            position: 'relative',
                          }}
                        >
                          {visibleHot.map((p, idx) => {
                            const rank = idx + 1
                            return (
                              <PostCard
                                key={p.id}
                                post={p}
                                rank={rank}
                                hotTag={getHotTag(p, rank)}
                                translatedTitle={translatedListPosts[p.id]?.title}
                                translatedBody={translatedListPosts[p.id]?.body}
                                isExpanded={!!expandedPosts[p.id]}
                                onToggleExpand={() =>
                                  setExpandedPosts((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                                }
                                onOpenPost={handleOpenPost}
                                localizedName={localizedName}
                                t={t}
                                language={_language}
                              />
                            )
                          })}
                        </Box>
                      )}
                    </>
                  )}

                  {/* Tab Content: Hot Groups -- lazy loaded */}
                  {activeHotTab === 'groups' && (
                    <Suspense
                      fallback={
                        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                          <Text color="tertiary">{t('loading')}</Text>
                        </Box>
                      }
                    >
                      <HotGroupsList
                        groups={groups}
                        loading={loadingGroups}
                        localizedName={localizedName}
                        t={t}
                      />
                    </Suspense>
                  )}
                </div>
              </Card>
            </Box>
          </ThreeColumnLayout>
        </Box>

        {/* Post detail modal -- lazy loaded */}
        {openPost && (
          <Suspense fallback={null}>
            <PostDetailModal
              post={openPost}
              comments={comments}
              loadingComments={loadingComments}
              hasMoreComments={hasMoreComments}
              loadingMoreComments={loadingMoreComments}
              newComment={newComment}
              setNewComment={setNewComment}
              submittingComment={submittingComment}
              translatedContent={translatedContent}
              showingOriginal={showingOriginal}
              translating={translating}
              accessToken={accessToken}
              onClose={handleClosePost}
              onSubmitComment={submitComment}
              onToggleReaction={toggleReaction}
              onToggleOriginal={() => setShowingOriginal(!showingOriginal)}
              onLoadMoreComments={loadMoreComments}
              localizedName={localizedName}
              t={t}
            />
          </Suspense>
        )}
        <Suspense fallback={null}>
          <FloatingActionButton />
        </Suspense>
      </PullToRefreshWrapper>
    </Box>
  )
}

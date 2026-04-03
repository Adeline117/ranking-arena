'use client'

import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCsrfHeaders } from '@/lib/api/client'
import { usePostStore } from '@/lib/stores/postStore'
import { logger } from '@/lib/logger'
import { haptic } from '@/lib/utils/haptics'
import { type PollChoice, type PostWithUserState } from '@/lib/types'

type Post = PostWithUserState

interface CustomPollState {
  customPoll: {
    id: string; question: string
    options: { text: string; votes: number | null }[]
    type: 'single' | 'multiple'; endAt: string | null
    isExpired: boolean; showResults: boolean; totalVotes: number | null
  } | null
  customPollUserVotes: number[]
  loadingCustomPoll: boolean
  votingCustomPoll: boolean
  selectedPollOptions: number[]
  setSelectedPollOptions: React.Dispatch<React.SetStateAction<number[]>>
  loadCustomPoll: (postId: string) => Promise<void>
  submitCustomPollVote: (postId: string) => Promise<void>
}

interface BookmarkRepostState {
  bookmarkLoading: Record<string, boolean>
  repostLoading: Record<string, boolean>
  showRepostModal: string | null; setShowRepostModal: (v: string | null) => void
  repostComment: string; setRepostComment: (v: string) => void
  userBookmarks: Record<string, boolean>; setUserBookmarks: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  bookmarkCounts: Record<string, number>; setBookmarkCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>
  setRepostCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>
  showBookmarkModal: boolean; setShowBookmarkModal: (v: boolean) => void
  bookmarkingPostId: string | null; setBookmarkingPostId: (v: string | null) => void
  handleBookmark: (postId: string) => Promise<void>
  openBookmarkFolderModal: (postId: string) => void
  handleBookmarkToFolder: (folderId: string) => Promise<void>
  handleRepost: (postId: string, comment?: string) => Promise<void>
  loadUserBookmarksAndReposts: (postIds: string[]) => Promise<void>
}

interface EditDeletePinState {
  editingPost: Post | null; setEditingPost: (v: Post | null) => void
  editTitle: string; setEditTitle: (v: string) => void
  editContent: string; setEditContent: (v: string) => void
  savingEdit: boolean
  handleStartEdit: (post: Post, e: React.MouseEvent) => void
  handleSaveEdit: () => Promise<void>
  handleDeletePost: (post: Post, e: React.MouseEvent) => Promise<void>
  handleTogglePin: (post: Post, e: React.MouseEvent) => Promise<void>
}

export interface PostActionsReturn extends CustomPollState, BookmarkRepostState, EditDeletePinState {
  toggleReaction: (postId: string, reactionType: 'up' | 'down') => Promise<void>
  _toggleVote: (postId: string, choice: PollChoice) => Promise<void>
}

export function usePostActions({
  accessToken, currentUserId, posts, setPosts, openPost, setOpenPost,
  showToast, showDangerConfirm, t,
}: {
  accessToken: string | null
  currentUserId: string | null
  posts: Post[]
  setPosts: React.Dispatch<React.SetStateAction<Post[]>>
  openPost: Post | null
  setOpenPost: (v: Post | null) => void
  showToast: (msg: string, type: 'error' | 'success' | 'warning' | 'info') => void
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
  t: (key: string) => string
}): PostActionsReturn {
  const router = useRouter()
  const lockRef = useRef<Set<string>>(new Set())
  const postsRef = useRef(posts); postsRef.current = posts

  // Edit state
  const [editingPost, setEditingPost] = useState<Post | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  // Custom poll state
  const [customPoll, setCustomPoll] = useState<CustomPollState['customPoll']>(null)
  const [customPollUserVotes, setCustomPollUserVotes] = useState<number[]>([])
  const [loadingCustomPoll, setLoadingCustomPoll] = useState(false)
  const [votingCustomPoll, setVotingCustomPoll] = useState(false)
  const [selectedPollOptions, setSelectedPollOptions] = useState<number[]>([])

  // Bookmark/repost state
  const [bookmarkLoading, setBookmarkLoading] = useState<Record<string, boolean>>({})
  const [repostLoading, setRepostLoading] = useState<Record<string, boolean>>({})
  const [showRepostModal, setShowRepostModal] = useState<string | null>(null)
  const [repostComment, setRepostComment] = useState('')
  const [userBookmarks, setUserBookmarks] = useState<Record<string, boolean>>({})
  const [bookmarkCounts, setBookmarkCounts] = useState<Record<string, number>>({})
  const [, setRepostCounts] = useState<Record<string, number>>({})
  const [showBookmarkModal, setShowBookmarkModal] = useState(false)
  const [bookmarkingPostId, setBookmarkingPostId] = useState<string | null>(null)

  // Toggle reaction
  const toggleReaction = useCallback(async (postId: string, reactionType: 'up' | 'down') => {
    if (!accessToken) { const { useLoginModal } = await import('@/lib/hooks/useLoginModal'); useLoginModal.getState().openLoginModal(); return }
    const key = `react-${postId}-${reactionType}`
    if (lockRef.current.has(key)) return
    lockRef.current.add(key)

    const prevPost = postsRef.current.find(p => p.id === postId)
    const prevOpenPost = openPost?.id === postId ? openPost : null

    if (prevPost) {
      const currentReaction = prevPost.user_reaction
      const newReaction = currentReaction === reactionType ? null : reactionType
      const optimistic = {
        like_count: prevPost.like_count + (reactionType === 'up' ? (currentReaction === 'up' ? -1 : 1) : (currentReaction === 'up' ? -1 : 0)),
        dislike_count: prevPost.dislike_count + (reactionType === 'down' ? (currentReaction === 'down' ? -1 : 1) : (currentReaction === 'down' ? -1 : 0)),
        user_reaction: newReaction,
      }
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, ...optimistic } : p))
      if (openPost?.id === postId) setOpenPost({ ...openPost, ...optimistic } as Post)
      haptic('light')
    }

    try {
      const response = await fetch(`/api/posts/${postId}/like`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() },
        body: JSON.stringify({ reaction_type: reactionType }),
      })
      const json = await response.json()
      if (response.ok && json.success) {
        const result = json.data
        const serverUpdate = { like_count: result.like_count, dislike_count: result.dislike_count, user_reaction: result.reaction }
        setPosts(prev => prev.map(p => p.id === postId ? { ...p, ...serverUpdate } : p))
        usePostStore.getState().updatePostReaction(postId, { like_count: result.like_count, dislike_count: result.dislike_count, reaction: result.reaction })
        if (openPost?.id === postId) setOpenPost({ ...openPost, ...serverUpdate } as Post)
      } else {
        if (prevPost) { setPosts(prev => prev.map(p => p.id === postId ? { ...p, like_count: prevPost.like_count, dislike_count: prevPost.dislike_count, user_reaction: prevPost.user_reaction } : p)); if (prevOpenPost) setOpenPost(prevOpenPost) }
        showToast(json.error || json.message || t('operationFailed'), 'error')
      }
    } catch (err) {
      if (prevPost) { setPosts(prev => prev.map(p => p.id === postId ? { ...p, like_count: prevPost.like_count, dislike_count: prevPost.dislike_count, user_reaction: prevPost.user_reaction } : p)); if (prevOpenPost) setOpenPost(prevOpenPost) }
      logger.error('[PostFeed] toggleReaction error:', err); showToast(t('networkError'), 'error')
    } finally { lockRef.current.delete(key) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t/setPosts/setOpenPost are stable refs; only re-create when auth or active post changes
  }, [accessToken, openPost?.id, showToast])

  // Built-in poll voting
  const _toggleVote = useCallback(async (postId: string, choice: PollChoice) => {
    if (!accessToken) { const { useLoginModal } = await import('@/lib/hooks/useLoginModal'); useLoginModal.getState().openLoginModal(); return }
    const key = `vote-${postId}-${choice}`
    if (lockRef.current.has(key)) return
    lockRef.current.add(key)
    try {
      const response = await fetch(`/api/posts/${postId}/vote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() },
        body: JSON.stringify({ choice }),
      })
      const json = await response.json()
      if (response.ok && json.success) {
        const result = json.data
        setPosts(prev => prev.map(p => p.id === postId ? { ...p, poll_bull: result.poll.bull, poll_bear: result.poll.bear, poll_wait: result.poll.wait, user_vote: result.vote } : p))
        if (openPost?.id === postId) setOpenPost({ ...openPost!, poll_bull: result.poll.bull, poll_bear: result.poll.bear, poll_wait: result.poll.wait, user_vote: result.vote })
      } else { showToast(json.error || json.message || t('voteFailed'), 'error') }
    } catch (err) { logger.error('[PostFeed] toggleVote error:', err); showToast(t('networkError'), 'error') }
    finally { lockRef.current.delete(key) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t/setPosts/setOpenPost are stable refs; only re-create when auth or active post changes
  }, [accessToken, openPost?.id, showToast])

  // Custom poll
  const loadCustomPoll = useCallback(async (postId: string) => {
    setLoadingCustomPoll(true); setCustomPoll(null); setCustomPollUserVotes([]); setSelectedPollOptions([])
    try {
      const headers: Record<string, string> = {}
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
      const response = await fetch(`/api/posts/${postId}/poll-vote`, { headers })
      const data = await response.json()
      if (response.ok && data.success && data.data?.poll) { setCustomPoll(data.data.poll); setCustomPollUserVotes(data.data.userVotes || []); setSelectedPollOptions(data.data.userVotes || []) }
    } catch { /* silent */ }
    finally { setLoadingCustomPoll(false) }
  }, [accessToken])

  const submitCustomPollVote = useCallback(async (postId: string) => {
    if (!accessToken) { const { useLoginModal } = await import('@/lib/hooks/useLoginModal'); useLoginModal.getState().openLoginModal(); return }
    if (selectedPollOptions.length === 0) { showToast(t('selectAtLeastOneOption'), 'warning'); return }
    setVotingCustomPoll(true)
    try {
      const response = await fetch(`/api/posts/${postId}/poll-vote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() },
        body: JSON.stringify({ optionIndexes: selectedPollOptions }),
      })
      const data = await response.json()
      if (response.ok && data.success) {
        setCustomPoll(prev => prev ? { ...prev, options: data.data.poll.options, showResults: true, totalVotes: data.data.poll.totalVotes } : null)
        setCustomPollUserVotes(data.data.userVotes); showToast(t('voted'), 'success')
      } else { showToast(data.error || t('voteFailed'), 'error') }
    } catch (err) { logger.error('[PostFeed] custom poll vote failed:', err); showToast(t('voteFailed'), 'error') }
    finally { setVotingCustomPoll(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t/showToast/setters are stable refs; only re-create when auth or selected options change
  }, [accessToken, selectedPollOptions])

  // Bookmark (with optimistic update, matching toggleReaction pattern)
  const handleBookmark = useCallback(async (postId: string) => {
    if (!accessToken) { const { useLoginModal } = await import('@/lib/hooks/useLoginModal'); useLoginModal.getState().openLoginModal(); return }
    if (bookmarkLoading[postId]) return
    setBookmarkLoading(prev => ({ ...prev, [postId]: true }))

    // Save previous state for rollback
    const prevBookmarked = userBookmarks[postId] ?? false
    const prevCount = bookmarkCounts[postId] ?? 0

    // Optimistic update: toggle bookmark immediately
    const optimisticBookmarked = !prevBookmarked
    setUserBookmarks(prev => ({ ...prev, [postId]: optimisticBookmarked }))
    setBookmarkCounts(prev => ({ ...prev, [postId]: optimisticBookmarked ? prevCount + 1 : Math.max(0, prevCount - 1) }))

    try {
      const response = await fetch(`/api/posts/${postId}/bookmark`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() } })
      const result = await response.json()
      if (response.ok) {
        // Reconcile with server state
        setUserBookmarks(prev => ({ ...prev, [postId]: result.bookmarked }))
        setBookmarkCounts(prev => ({ ...prev, [postId]: result.bookmark_count }))
        showToast(result.bookmarked ? t('bookmarked') : t('unbookmarked'), 'success')
      } else {
        // Rollback on server error
        setUserBookmarks(prev => ({ ...prev, [postId]: prevBookmarked }))
        setBookmarkCounts(prev => ({ ...prev, [postId]: prevCount }))
        showToast(result.error || t('operationFailed'), 'error')
      }
    } catch {
      // Rollback on network error
      setUserBookmarks(prev => ({ ...prev, [postId]: prevBookmarked }))
      setBookmarkCounts(prev => ({ ...prev, [postId]: prevCount }))
      showToast(t('networkError'), 'error')
    } finally { setBookmarkLoading(prev => ({ ...prev, [postId]: false })) }
  }, [accessToken, showToast, t, bookmarkLoading, userBookmarks, bookmarkCounts])

  const openBookmarkFolderModal = useCallback((postId: string) => {
    if (!accessToken) { showToast(t('pleaseLogin'), 'warning'); return }
    setBookmarkingPostId(postId); setShowBookmarkModal(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable ref t excluded to avoid re-creating callback
  }, [accessToken, showToast])

  const handleBookmarkToFolder = useCallback(async (folderId: string) => {
    if (!accessToken || !bookmarkingPostId) return
    setBookmarkLoading(prev => ({ ...prev, [bookmarkingPostId]: true }))
    try {
      const response = await fetch(`/api/posts/${bookmarkingPostId}/bookmark`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() }, body: JSON.stringify({ folder_id: folderId }) })
      const result = await response.json()
      if (response.ok) { setUserBookmarks(prev => ({ ...prev, [bookmarkingPostId]: result.bookmarked })); setBookmarkCounts(prev => ({ ...prev, [bookmarkingPostId]: result.bookmark_count })); showToast(t('bookmarked'), 'success') }
      else { showToast(result.error || t('operationFailed'), 'error') }
    } catch { showToast(t('networkError'), 'error') }
    finally { setBookmarkLoading(prev => ({ ...prev, [bookmarkingPostId]: false })); setShowBookmarkModal(false); setBookmarkingPostId(null) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable ref t excluded to avoid re-creating callback
  }, [accessToken, bookmarkingPostId, showToast])

  // Repost
  const handleRepost = useCallback(async (postId: string, comment?: string) => {
    if (!accessToken) { const { useLoginModal } = await import('@/lib/hooks/useLoginModal'); useLoginModal.getState().openLoginModal(); return }
    const post = posts.find(p => p.id === postId) || openPost
    if (post?.author_id === currentUserId) { showToast(t('cannotRepostOwn'), 'warning'); return }
    setRepostLoading(prev => ({ ...prev, [postId]: true }))
    try {
      const response = await fetch(`/api/posts/${postId}/repost`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() }, body: JSON.stringify({ comment }) })
      const result = await response.json()
      if (response.ok) { setShowRepostModal(null); setRepostComment(''); showToast(t('reposted'), 'success') }
      else { showToast(result.error || t('repostFailed'), 'error') }
    } catch (err) { logger.error('[PostFeed] repost failed:', err); showToast(t('networkError'), 'error') }
    finally { setRepostLoading(prev => ({ ...prev, [postId]: false })) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable ref t excluded to avoid re-creating callback
  }, [accessToken, posts, openPost, currentUserId, showToast])

  // Load user bookmarks
  const loadUserBookmarksAndReposts = useCallback(async (postIds: string[]) => {
    if (!accessToken || postIds.length === 0) return
    const controller = new AbortController()
    try {
      const res = await fetch('/api/posts/bookmarks/status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() }, body: JSON.stringify({ postIds }), signal: controller.signal })
      if (controller.signal.aborted) return
      const data = await res.json()
      if (!controller.signal.aborted) setUserBookmarks(prev => ({ ...prev, ...(data.bookmarks || {}) }))
    } catch (err) { if (err instanceof Error && err.name === 'AbortError') return }
  }, [accessToken])

  // Edit
  const handleStartEdit = useCallback((post: Post, e: React.MouseEvent) => { e.stopPropagation(); router.push(`/post/${post.id}/edit`) }, [router])

  const handleSaveEdit = useCallback(async () => {
    if (!editingPost || !accessToken) return
    if (!editTitle.trim()) { showToast(t('titleRequired'), 'warning'); return }
    setSavingEdit(true)
    try {
      const response = await fetch(`/api/posts/${editingPost.id}/edit`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() }, body: JSON.stringify({ title: editTitle.trim(), content: editContent.trim() }) })
      const data = await response.json()
      if (response.ok) {
        setPosts(prev => prev.map(p => p.id === editingPost.id ? { ...p, title: editTitle.trim(), content: editContent.trim() } : p))
        if (openPost?.id === editingPost.id) setOpenPost({ ...openPost!, title: editTitle.trim(), content: editContent.trim() })
        setEditingPost(null); showToast(t('editSaved'), 'success')
      } else { showToast(data.error || t('editFailed'), 'error') }
    } catch (err) { logger.error('[PostFeed] edit failed:', err); showToast(t('editFailed'), 'error') }
    finally { setSavingEdit(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable refs t, setPosts, setOpenPost excluded to avoid re-creating callback
  }, [editingPost, accessToken, editTitle, editContent, openPost?.id, showToast])

  // Delete
  const handleDeletePost = useCallback(async (post: Post, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!accessToken) { showToast(t('pleaseLogin'), 'warning'); return }
    if (!(await showDangerConfirm(t('deletePost'), t('deletePostConfirm')))) return
    try {
      const response = await fetch(`/api/posts/${post.id}/delete`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() } })
      const data = await response.json()
      if (response.ok) { setPosts(prev => prev.filter(p => p.id !== post.id)); if (openPost?.id === post.id) setOpenPost(null); showToast(t('deleted'), 'success') }
      else { showToast(data.error || t('deleteFailed'), 'error') }
    } catch { showToast(t('deleteFailed'), 'error') }
  }, [accessToken, openPost?.id, setOpenPost, setPosts, showDangerConfirm, showToast, t])

  // Pin
  const handleTogglePin = useCallback(async (post: Post, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!accessToken) { showToast(t('pleaseLogin'), 'warning'); return }
    try {
      const response = await fetch(`/api/posts/${post.id}/pin`, { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() } })
      const data = await response.json()
      if (response.ok && data.success) {
        setPosts(prev => prev.map(p => { if (p.id === post.id) return { ...p, is_pinned: data.data.is_pinned }; if (data.data.is_pinned && p.is_pinned) return { ...p, is_pinned: false }; return p }))
        showToast(data.data.message, 'success')
      } else { showToast(data.error || t('operationFailed'), 'error') }
    } catch { showToast(t('operationFailed'), 'error') }
  }, [accessToken, setPosts, showToast, t])

  return {
    toggleReaction, _toggleVote,
    customPoll, customPollUserVotes, loadingCustomPoll, votingCustomPoll,
    selectedPollOptions, setSelectedPollOptions, loadCustomPoll, submitCustomPollVote,
    bookmarkLoading, repostLoading, showRepostModal, setShowRepostModal,
    repostComment, setRepostComment, userBookmarks, setUserBookmarks,
    bookmarkCounts, setBookmarkCounts, setRepostCounts,
    showBookmarkModal, setShowBookmarkModal, bookmarkingPostId, setBookmarkingPostId,
    handleBookmark, openBookmarkFolderModal, handleBookmarkToFolder, handleRepost,
    loadUserBookmarksAndReposts,
    editingPost, setEditingPost, editTitle, setEditTitle, editContent, setEditContent,
    savingEdit, handleStartEdit, handleSaveEdit, handleDeletePost, handleTogglePin,
  }
}

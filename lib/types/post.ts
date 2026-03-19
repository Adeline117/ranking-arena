/**
 * 帖子相关类型定义
 */

export type PostVisibility = 'public' | 'followers' | 'group'

export interface Post {
  id: string
  title: string
  content: string
  author_id: string
  author_handle: string
  group_id?: string | null
  poll_enabled: boolean
  poll_id?: string | null
  poll_bull: number
  poll_bear: number
  poll_wait: number
  like_count: number
  dislike_count: number
  comment_count: number
  bookmark_count: number
  repost_count: number
  view_count: number
  hot_score: number
  is_pinned: boolean
  images?: string[] | null
  created_at: string
  updated_at?: string | null
  // 转发相关
  original_post_id?: string | null
  // Visibility level
  visibility?: PostVisibility
  // Content warning / sensitive flag
  is_sensitive?: boolean
  content_warning?: string | null
  // Language detection
  language?: string
}

export interface PostWithAuthor extends Post {
  author_avatar_url?: string | null
  author_is_pro?: boolean
  author_show_pro_badge?: boolean
  author_exp?: number
  group_name?: string | null
  group_name_en?: string | null
  // 原始帖子信息（如果是转发）
  original_post?: {
    id: string
    title: string
    content: string
    author_handle: string
    author_avatar_url?: string | null
    author_is_pro?: boolean
    author_show_pro_badge?: boolean
    images?: string[] | null
    created_at: string
  } | null
}

export interface PostWithUserState extends PostWithAuthor {
  user_reaction?: 'up' | 'down' | null
  user_vote?: PollChoice | null
}

export interface CreatePostInput {
  title: string
  content: string
  group_id?: string
  poll_enabled?: boolean
  visibility?: PostVisibility
  is_sensitive?: boolean
  content_warning?: string
  language?: string
}

export interface UpdatePostInput {
  title?: string
  content?: string
  poll_enabled?: boolean
  visibility?: PostVisibility
  is_sensitive?: boolean
  content_warning?: string | null
}

export interface PostListOptions {
  limit?: number
  offset?: number
  group_id?: string
  author_handle?: string
  sort_by?: 'created_at' | 'hot_score' | 'like_count'
  sort_order?: 'asc' | 'desc'
}

export type PollChoice = 'bull' | 'bear' | 'wait'
export type ReactionType = 'up' | 'down'

export interface PollState {
  bull: number
  bear: number
  wait: number
}

/**
 * 获取投票胜出方
 */
export function getPollWinner(poll: PollState): PollChoice | 'tie' {
  const arr: Array<[PollChoice, number]> = [
    ['bull', poll.bull],
    ['bear', poll.bear],
    ['wait', poll.wait],
  ]
  arr.sort((a, b) => b[1] - a[1])
  if (arr[0][1] === arr[1][1]) return 'tie'
  return arr[0][0]
}


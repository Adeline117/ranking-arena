/**
 * 评论相关类型定义
 */

export interface Comment {
  id: string
  post_id: string
  user_id: string
  content: string
  parent_id?: string | null
  like_count: number
  created_at: string
  updated_at: string
}

export interface CommentWithAuthor extends Comment {
  author_handle?: string
  author_avatar_url?: string | null
  replies?: CommentWithAuthor[]
}

export interface CreateCommentInput {
  post_id: string
  content: string
  parent_id?: string
}


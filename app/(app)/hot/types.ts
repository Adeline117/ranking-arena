export type Trader = {
  id: string
  handle: string | null
  roi: number
  win_rate: number
  followers: number
  source?: string
}

export type Post = {
  id: string
  group: string
  group_en?: string
  group_id?: string
  title: string
  author: string
  author_handle?: string
  author_avatar_url?: string | null
  author_display_name?: string | null
  time: string
  body: string
  /** Standard field name (alias for body) — enables shared component compatibility */
  content?: string
  comments: number
  likes: number
  /** Standard field names (aliases) — enables shared component compatibility */
  like_count?: number
  comment_count?: number
  dislike_count?: number
  dislikes?: number
  hotScore: number
  hot_score?: number
  views: number
  view_count?: number
  created_at?: string
  user_reaction?: 'up' | 'down' | null
}

export type Comment = {
  id: string
  content: string
  user_id: string
  author_handle?: string
  author_avatar_url?: string
  created_at: string
  replies?: Comment[]
}

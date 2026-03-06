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
  time: string
  body: string
  comments: number
  likes: number
  dislikes?: number
  hotScore: number
  views: number
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

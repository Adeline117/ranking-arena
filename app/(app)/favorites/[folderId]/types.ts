export interface BookmarkFolder {
  id: string
  user_id: string
  name: string
  description?: string | null
  avatar_url?: string | null
  is_public: boolean
  is_default: boolean
  post_count: number
  subscriber_count: number
  created_at: string
  owner_handle?: string
  owner_avatar_url?: string | null
}

export interface BookmarkedPost {
  bookmark_id: string
  bookmarked_at: string
  id: string
  title: string
  content: string | null
  author_id: string
  author_handle: string | null
  group_id?: string | null
  like_count: number | null
  comment_count: number | null
  bookmark_count: number | null
  created_at: string
}

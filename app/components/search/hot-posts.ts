export interface HotPostSource {
  id: string
  title?: string | null
  content?: string | null
  hot_score?: number | null
  view_count?: number | null
  like_count?: number | null
  comment_count?: number | null
}

export interface HotPostItem {
  id: string
  title: string
  hotScore: number
  rank: number
  view_count?: number
}

export function mapHotPosts(posts: HotPostSource[], noTitle: string): HotPostItem[] {
  return posts.map((post, index) => {
    const rawTitle = post.title?.trim()
    const hasRealTitle = rawTitle && rawTitle.toLowerCase() !== 'untitled'
    let title: string

    if (hasRealTitle) {
      title = rawTitle
    } else if (post.content) {
      const plain = post.content.replace(/[#*_~`>|\[\]()]/g, '').trim()
      title = plain.length > 80 ? `${plain.slice(0, 80)}...` : plain
    } else {
      title = noTitle
    }

    return {
      id: post.id,
      title,
      hotScore:
        post.hot_score ??
        (post.view_count ?? 0) * 0.1 + (post.like_count ?? 0) * 2 + (post.comment_count ?? 0) * 3,
      rank: index + 1,
      view_count: post.view_count ?? undefined,
    }
  })
}

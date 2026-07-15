import { mapHotPosts } from '../hot-posts'

describe('mapHotPosts', () => {
  it('keeps a real title and a zero hot score', () => {
    expect(
      mapHotPosts(
        [
          {
            id: 'post-1',
            title: 'Market update',
            hot_score: 0,
            view_count: 12,
            like_count: 3,
          },
        ],
        'No title'
      )
    ).toEqual([
      {
        id: 'post-1',
        title: 'Market update',
        hotScore: 0,
        rank: 1,
        view_count: 12,
      },
    ])
  })

  it('uses a clean content snippet for untitled posts', () => {
    const content = `# ${'A'.repeat(85)} **signal**`
    const [post] = mapHotPosts([{ id: 'post-2', title: 'Untitled', content }], 'No title')

    expect(post.title).toHaveLength(83)
    expect(post.title.endsWith('...')).toBe(true)
  })

  it('calculates a fallback score and localizes an empty title', () => {
    expect(
      mapHotPosts(
        [
          {
            id: 'post-3',
            view_count: 10,
            like_count: 2,
            comment_count: 1,
          },
        ],
        '暂无标题'
      )[0]
    ).toMatchObject({ title: '暂无标题', hotScore: 8, rank: 1 })
  })
})

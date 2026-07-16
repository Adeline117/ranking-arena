import { shouldLoadExpandedGroupComments } from '../group-comment-read'

describe('group comment authenticated read gate', () => {
  it('does not issue or cache an anonymous member-only read before auth restoration', () => {
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: null,
        expanded: true,
        hasCachedComments: false,
        loading: false,
      })
    ).toBe(false)
  })

  it('retries an expanded uncached thread when the token arrives, but not after cache/load starts', () => {
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: 'token-1',
        expanded: true,
        hasCachedComments: false,
        loading: false,
      })
    ).toBe(true)
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: 'token-1',
        expanded: true,
        hasCachedComments: true,
        loading: false,
      })
    ).toBe(false)
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: 'token-1',
        expanded: true,
        hasCachedComments: false,
        loading: true,
      })
    ).toBe(false)
  })
})

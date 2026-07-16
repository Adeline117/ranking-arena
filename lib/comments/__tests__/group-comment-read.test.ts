import { shouldLoadExpandedGroupComments } from '../group-comment-read'

describe('group comment authenticated read gate', () => {
  it('does not issue or cache an anonymous member-only read before auth restoration', () => {
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: null,
        authChecked: false,
        audienceResolved: false,
        groupVisibility: null,
        isMember: false,
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
        authChecked: true,
        audienceResolved: true,
        groupVisibility: 'apply',
        isMember: true,
        expanded: true,
        hasCachedComments: false,
        loading: false,
      })
    ).toBe(true)
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: 'token-1',
        authChecked: true,
        audienceResolved: true,
        groupVisibility: 'apply',
        isMember: true,
        expanded: true,
        hasCachedComments: true,
        loading: false,
      })
    ).toBe(false)
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: 'token-1',
        authChecked: true,
        audienceResolved: true,
        groupVisibility: 'apply',
        isMember: true,
        expanded: true,
        hasCachedComments: false,
        loading: true,
      })
    ).toBe(false)
  })

  it('allows an anonymous expanded thread only after an open audience resolves', () => {
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: null,
        authChecked: true,
        audienceResolved: true,
        groupVisibility: 'open',
        isMember: false,
        expanded: true,
        hasCachedComments: false,
        loading: false,
      })
    ).toBe(true)
    expect(
      shouldLoadExpandedGroupComments({
        accessToken: null,
        authChecked: true,
        audienceResolved: true,
        groupVisibility: 'apply',
        isMember: false,
        expanded: true,
        hasCachedComments: false,
        loading: false,
      })
    ).toBe(false)
  })
})

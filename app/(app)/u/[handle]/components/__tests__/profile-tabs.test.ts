import { canonicalProfileTab, getAvailableProfileTabs } from '../profile-tabs'

describe('user profile tab availability', () => {
  it('exposes only overview without an actual trader binding', () => {
    expect(getAvailableProfileTabs({ hasTraderBinding: false, hasPostsContent: true })).toEqual([
      'overview',
    ])
  })

  it('exposes each implemented trader panel when its posts content is available', () => {
    expect(getAvailableProfileTabs({ hasTraderBinding: true, hasPostsContent: true })).toEqual([
      'overview',
      'stats',
      'portfolio',
      'posts',
    ])
  })

  it('does not expose posts when that panel has no content owner', () => {
    expect(getAvailableProfileTabs({ hasTraderBinding: true, hasPostsContent: false })).toEqual([
      'overview',
      'stats',
      'portfolio',
    ])
  })

  it('canonicalizes unavailable and unknown query values to overview', () => {
    const userTabs = getAvailableProfileTabs({
      hasTraderBinding: false,
      hasPostsContent: false,
    })

    expect(canonicalProfileTab('stats', userTabs)).toBe('overview')
    expect(canonicalProfileTab('posts', userTabs)).toBe('overview')
    expect(canonicalProfileTab('unknown', userTabs)).toBe('overview')
    expect(canonicalProfileTab(null, userTabs)).toBe('overview')
  })
})

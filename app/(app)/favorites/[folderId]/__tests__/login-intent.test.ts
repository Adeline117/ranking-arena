import { buildFavoriteFolderLoginHref, buildFavoriteFolderReturnPath } from '../login-intent'

describe('favorite folder login intent', () => {
  it('returns users to the exact folder after login', () => {
    expect(buildFavoriteFolderReturnPath('folder-1')).toBe('/favorites/folder-1')
    expect(buildFavoriteFolderLoginHref('folder-1')).toBe(
      '/login?returnUrl=%2Ffavorites%2Ffolder-1'
    )
  })

  it('keeps reserved characters inside the folder path segment', () => {
    const returnPath = buildFavoriteFolderReturnPath('folder/with?reserved#characters')

    expect(returnPath).toBe('/favorites/folder%2Fwith%3Freserved%23characters')
    expect(
      new URL(
        buildFavoriteFolderLoginHref('folder/with?reserved#characters'),
        'https://arena.test'
      ).searchParams.get('returnUrl')
    ).toBe(returnPath)
  })

  it('falls back to favorites before the route param resolves', () => {
    expect(buildFavoriteFolderReturnPath('')).toBe('/favorites')
    expect(buildFavoriteFolderLoginHref('')).toBe('/login?returnUrl=%2Ffavorites')
  })
})

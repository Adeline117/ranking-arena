import {
  getSearchResultHref,
  mapPeopleSearchResults,
  type SearchResult,
} from '../search-result-model'

describe('search People result model', () => {
  it('keeps the API-built public handle href byte-for-byte', () => {
    const [person] = mapPeopleSearchResults([
      {
        id: 'user-uuid-not-a-handle',
        type: 'user',
        title: '@Alice Zhang',
        subtitle: '@Alice Zhang',
        href: '/u/Alice%20Zhang',
        avatar: 'https://cdn.example/avatar.png',
      },
    ])

    expect(person).toEqual({
      type: 'user',
      id: 'user-uuid-not-a-handle',
      title: '@Alice Zhang',
      subtitle: undefined,
      href: '/u/Alice%20Zhang',
      avatar: 'https://cdn.example/avatar.png',
    })
    expect(getSearchResultHref(person)).toBe('/u/Alice%20Zhang')
    expect(getSearchResultHref(person)).not.toContain('user-uuid-not-a-handle')
  })

  it('does not coerce a personal user result into a trader result', () => {
    const [person] = mapPeopleSearchResults([
      {
        id: 'user-1',
        type: 'user',
        title: '@alice',
        subtitle: 'Macro researcher',
        href: '/u/alice',
      },
    ])

    expect(person.type).toBe('user')
    expect(person.subtitle).toBe('Macro researcher')
    expect(person.roi).toBeUndefined()
    expect(person.score).toBeUndefined()
  })

  it('fails closed when a user result has no API destination', () => {
    const result: SearchResult = {
      type: 'user',
      id: 'user-1',
      title: '@alice',
    }
    expect(getSearchResultHref(result)).toBe('#')
  })
})

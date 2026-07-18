import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('search page People integration contract', () => {
  const client = source('app/(app)/search/SearchPageClient.tsx')

  it('includes users in mapping, history, totals, All, and a dedicated People tab', () => {
    expect(client).toContain('mapPeopleSearchResults(data.results.users || [])')
    expect(client).toContain('(rawSearchData.results.users || []).length')
    expect(client).toContain(
      'groupResults.length + peopleResults.length + postResults.length + traderResults.length'
    )
    expect(client).toContain('groupTotal + peopleTotal + postTotal + traderTotal')
    expect(client).toContain("{ key: 'people', label: t('searchTabPeople'), count: peopleTotal }")
  })

  it('keeps traders first and threads People through roving keyboard offsets', () => {
    const traderOrder = client.indexOf('if (tradersShown) list.push(...traderResults)')
    const postOrder = client.indexOf('if (postsShown) list.push(...postResults)')
    const peopleOrder = client.indexOf('if (peopleShown) list.push(...peopleResults)')
    const groupOrder = client.indexOf('if (groupsShown) list.push(...groupResults)')

    expect(traderOrder).toBeGreaterThan(-1)
    expect(postOrder).toBeGreaterThan(traderOrder)
    expect(peopleOrder).toBeGreaterThan(postOrder)
    expect(groupOrder).toBeGreaterThan(peopleOrder)
    expect(client).toContain(
      'const peopleOffset = postOffset + (postsShown ? postResults.length : 0)'
    )
    expect(client).toContain(
      'const groupOffset = peopleOffset + (peopleShown ? peopleResults.length : 0)'
    )
  })

  it('keeps platform pills trader-scoped and gives category links mobile and keyboard semantics', () => {
    expect(client).toContain("(activeTab === 'all' || activeTab === 'traders') &&")
    expect(client).toContain('className="touch-target"')
    expect(client).toContain("aria-current={activeTab === tab.key ? 'page' : undefined}")
    expect(client).toContain("activeTab === 'all' || activeTab === 'people'")
  })

  it('shows only populated sections in All while preserving a category-specific empty state', () => {
    expect(client).toContain("(activeTab !== 'all' || peopleResults.length > 0)")
    expect(client).toContain("t('searchNoSectionResults').replace('{type}', title)")
  })

  it('ships the People label in every supported locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'ko']) {
      expect(source(`lib/i18n/${locale}.ts`)).toContain('searchTabPeople:')
    }
  })
})

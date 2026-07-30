import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'
import { HotGroupsList } from '../components/HotGroupsList'

describe('Hot Groups honest semantics', () => {
  it('renders the recently active sequence without fabricated ranks or medal styling', () => {
    const { container } = render(
      <HotGroupsList
        groups={[
          {
            id: 'group-recent-a',
            name: '最近更新 A',
            name_en: 'Recently updated A',
            member_count: 12,
          },
          {
            id: 'group-recent-b',
            name: '最近更新 B',
            name_en: 'Recently updated B',
            member_count: 8,
          },
          {
            id: 'group-recent-c',
            name: '最近更新 C',
            name_en: 'Recently updated C',
            member_count: 5,
          },
        ]}
        loading={false}
        localizedName={(_zhName, enName) => enName ?? _zhName}
        t={(key) => ({ membersUnit: 'members' })[key] ?? key}
      />
    )

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/groups/group-recent-a',
      '/groups/group-recent-b',
      '/groups/group-recent-c',
    ])
    expect(screen.getByText('Recently updated A')).toBeInTheDocument()
    expect(screen.getByText('12 members')).toBeInTheDocument()
    expect(screen.queryAllByText(/^#\d+$/)).toHaveLength(0)
    expect(container.innerHTML).not.toContain('color-accent-warning')
  })

  it('labels the updated_at sequence as recently active rather than hot or popular', () => {
    expect(en.hotGroups).toBe('Recently Active Groups')
    expect(zh.hotGroups).toBe('最近活跃小组')
    expect(ja.hotGroups).toBe('最近アクティブなグループ')
    expect(ko.hotGroups).toBe('최근 활동 그룹')
  })

  it('keeps the tab wired to the recency endpoint without claiming an activity score', () => {
    const content = readFileSync(join(process.cwd(), 'app/(app)/hot/HotContent.tsx'), 'utf8')
    const hook = readFileSync(join(process.cwd(), 'app/(app)/hot/useHotPageData.ts'), 'utf8')

    expect(content).toContain("{ value: 'groups' as const, label: t('hotGroups') }")
    expect(hook).toContain("'/api/groups?sort_by=activity&limit=30'")
    expect(hook).not.toMatch(/activity[_A-Z]?score/i)
  })
})
